import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionPath = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url));
const evidencePath = fileURLToPath(new URL('../test-results/', import.meta.url));
const report = {
  test: 'live Google Meet page before joining',
  mockedNetwork: false,
  meetingJoined: false,
  permissionsGranted: [],
  urlTransitions: [],
  checks: {},
  outcome: 'failed',
};
let context;
let page;
let profilePath;
let controlContext;
let controlProfilePath;
let cleanupTimedOut = false;

function urlWithoutQuery(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeWithDialog(decision) {
  const handled = page.waitForEvent('dialog', { timeout: 8_000 }).then(async (dialog) => {
    const type = dialog.type();
    await dialog[decision]();
    assert.equal(type, 'beforeunload');
  });
  const closed = decision === 'accept'
    ? page.waitForEvent('close', { timeout: 8_000 })
    : Promise.resolve();
  await Promise.all([handled, closed, page.close({ runBeforeUnload: true })]);
}

async function activateNeutral(targetPage) {
  const { width, height } = targetPage.viewportSize();
  for (const point of [{ x: 8, y: 8 }, { x: width - 8, y: 8 }, { x: 8, y: height - 8 }, { x: width - 8, y: height - 8 }]) {
    const safe = await targetPage.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return Boolean(target && !target.closest(
        'a,button,input,select,textarea,iframe,[role="button"],[role="link"],[onclick],[tabindex],[contenteditable]',
      ));
    }, point);
    if (!safe) continue;
    await targetPage.mouse.click(point.x, point.y);
    const hasBeenActive = await targetPage.evaluate(() => navigator.userActivation.hasBeenActive);
    assert.equal(hasBeenActive, true, 'The browser did not record trusted user interaction');
    return { point, hasBeenActive };
  }
  throw new Error('No neutral activation point is available without clicking an interactive control');
}

const browserOptions = {
  channel: 'chromium',
  headless: true,
  permissions: [],
  viewport: { width: 1280, height: 900 },
  timeout: 30_000,
};

try {
  await mkdir(evidencePath, { recursive: true });
  const requested = new URL(process.env.LIVE_MEET_URL ?? '');
  assert.equal(requested.origin, 'https://meet.google.com', 'Only Google Meet HTTPS URLs are allowed');
  assert.ok(requested.pathname.startsWith('/meet/'), 'The requested path must start with /meet/');
  assert.equal(requested.username + requested.password, '', 'URL credentials are not allowed');
  report.requestedUrl = urlWithoutQuery(requested.href);
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  report.extension = { name: manifest.name, version: manifest.version, contentScripts: manifest.content_scripts };
  profilePath = await mkdtemp(join(tmpdir(), 'meet-tab-guard-live-'));
  context = await chromium.launchPersistentContext(profilePath, {
    ...browserOptions,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--deny-permission-prompts',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  report.browserVersion = context.browser()?.version();
  context.setDefaultTimeout(10_000);
  // Leave the initial blank tab open so accepting close does not end the browser.
  page = await context.newPage();
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      report.urlTransitions.push(urlWithoutQuery(frame.url()));
    }
  });
  const response = await page.goto(requested.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  report.httpStatus = response?.status();
  await page.waitForTimeout(5_000);
  report.finalUrl = urlWithoutQuery(page.url());
  report.finalPath = new URL(page.url()).pathname;
  report.title = (await page.title()).slice(0, 300);
  report.pageTextExcerpt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500);
  await page.screenshot({ path: join(evidencePath, 'live-meet.png') });

  const current = new URL(page.url());
  if (current.origin !== requested.origin || !current.pathname.startsWith('/meet/')) {
    report.outcome = 'redirected_outside_scope';
    throw new Error('The live page redirected outside the configured /meet/ scope');
  }

  report.userActivation = await activateNeutral(page);
  const loadedUrl = page.url();
  const marker = randomUUID();
  await page.evaluate((value) => { window.__mtgHarnessSmokeMarker = value; }, marker);
  await closeWithDialog('dismiss');
  assert.equal(page.isClosed(), false);
  assert.equal(page.url(), loadedUrl);
  assert.equal(await page.evaluate(() => window.__mtgHarnessSmokeMarker), marker);
  report.checks.cancelKeepsTabAndDocument = true;
  await page.screenshot({ path: join(evidencePath, 'live-meet.png') });
  await closeWithDialog('accept');
  assert.equal(page.isClosed(), true);
  report.checks.secondConfirmationAndApprovedClose = true;

  // A fresh control profile checks whether the site already prompts by itself.
  report.control = { extensionEnabled: false, dialogTypes: [] };
  controlProfilePath = await mkdtemp(join(tmpdir(), 'meet-tab-guard-live-control-'));
  controlContext = await chromium.launchPersistentContext(controlProfilePath, {
    ...browserOptions,
    args: ['--deny-permission-prompts'],
  });
  controlContext.setDefaultTimeout(10_000);
  const controlPage = await controlContext.newPage();
  await controlPage.goto(requested.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await controlPage.waitForTimeout(5_000);
  report.control.finalUrl = urlWithoutQuery(controlPage.url());
  report.control.title = (await controlPage.title()).slice(0, 300);
  report.control.userActivation = await activateNeutral(controlPage);
  await controlPage.screenshot({ path: join(evidencePath, 'live-meet-control.png') });
  const controlDialogTasks = [];
  controlPage.on('dialog', (dialog) => {
    report.control.dialogTypes.push(dialog.type());
    const task = dialog.accept();
    controlDialogTasks.push(task);
    task.catch(() => {});
  });
  await Promise.all([
    controlPage.waitForEvent('close', { timeout: 8_000 }),
    controlPage.close({ runBeforeUnload: true }),
  ]);
  await Promise.all(controlDialogTasks);
  report.control.sitePromptsWithoutExtension = report.control.dialogTypes.includes('beforeunload');
  report.outcome = 'passed';
} catch (error) {
  // Keep only our error message, not Playwright call logs with possible auth URLs.
  report.error = String(error.message).split('\n')[0].replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try { return urlWithoutQuery(url); } catch { return '[URL]'; }
  });
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    await bounded(page.screenshot({ path: join(evidencePath, 'live-meet.png') }), 5_000, 'Failure screenshot').catch(() => {});
  }
} finally {
  for (const browserContext of [context, controlContext].filter(Boolean)) {
    await bounded(browserContext.close(), 10_000, 'Browser cleanup').catch((error) => {
      report.cleanupError = error.message;
      cleanupTimedOut = true;
      process.exitCode = 1;
    });
  }
  for (const profile of [profilePath, controlProfilePath].filter(Boolean)) {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(evidencePath, { recursive: true });
  await writeFile(join(evidencePath, 'live-meet.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (cleanupTimedOut) process.exit(1);
}
