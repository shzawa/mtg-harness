import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { BrowserContext, Dialog, Page } from 'playwright';

type DialogDecision = 'accept' | 'dismiss';
type ActivationResult = { point: { x: number; y: number }; hasBeenActive: boolean };
type SmokeWindow = Window & { __mtgHarnessSmokeMarker?: string };
type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

interface ControlReport {
  extensionEnabled: false;
  dialogTypes: ReturnType<Dialog['type']>[];
  finalUrl?: string;
  title?: string;
  userActivation?: ActivationResult;
  sitePromptsWithoutExtension?: boolean;
}

interface LiveCheckReport {
  test: string;
  mockedNetwork: false;
  meetingJoined: false;
  permissionsGranted: string[];
  urlTransitions: string[];
  checks: {
    cancelKeepsTabAndDocument?: boolean;
    secondConfirmationAndApprovedClose?: boolean;
  };
  outcome: 'failed' | 'redirected_outside_scope' | 'passed' | 'failed_cleanup';
  requestedUrl?: string;
  extension?: { name: string; version: string; contentScripts: unknown[] | undefined };
  browserVersion?: string | undefined;
  httpStatus?: number | undefined;
  finalUrl?: string;
  finalPath?: string;
  title?: string;
  pageTextExcerpt?: string;
  userActivation?: ActivationResult;
  control?: ControlReport;
  extensionAttribution?: 'inconclusive-site-also-prompts' | 'prompt-observed-only-with-extension';
  error?: string;
  cleanupError?: string;
}

const extensionPath = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url));
const evidencePath = fileURLToPath(new URL('../test-results/', import.meta.url));
const report: LiveCheckReport = {
  test: 'live Google Meet page before joining',
  mockedNetwork: false,
  meetingJoined: false,
  permissionsGranted: [],
  urlTransitions: [],
  checks: {},
  outcome: 'failed',
};
let context: BrowserContext | undefined;
let page: Page | undefined;
let profilePath: string | undefined;
let controlContext: BrowserContext | undefined;
let controlProfilePath: string | undefined;
let cleanupTimedOut = false;

function urlWithoutQuery(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeWithDialog(targetPage: Page, decision: DialogDecision): Promise<void> {
  const handled = targetPage.waitForEvent('dialog', { timeout: 8_000 }).then(async (dialog) => {
    const type = dialog.type();
    await dialog[decision]();
    assert.equal(type, 'beforeunload');
  });
  const closed =
    decision === 'accept'
      ? targetPage.waitForEvent('close', { timeout: 8_000 })
      : Promise.resolve();
  await Promise.all([handled, closed, targetPage.close({ runBeforeUnload: true })]);
}

async function activateNeutral(targetPage: Page): Promise<ActivationResult> {
  const viewport = targetPage.viewportSize();
  assert.ok(viewport, 'A fixed viewport is required to find a neutral activation point');
  const { width, height } = viewport;
  for (const point of [
    { x: 8, y: 8 },
    { x: width - 8, y: 8 },
    { x: 8, y: height - 8 },
    { x: width - 8, y: height - 8 },
  ]) {
    const safe = await targetPage.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return Boolean(
        target &&
        !target.closest(
          'a,button,input,select,textarea,iframe,[role="button"],[role="link"],[onclick],[tabindex],[contenteditable]',
        ),
      );
    }, point);
    if (!safe) continue;
    await targetPage.mouse.click(point.x, point.y);
    const hasBeenActive = await targetPage.evaluate(() => navigator.userActivation.hasBeenActive);
    assert.equal(hasBeenActive, true, 'The browser did not record trusted user interaction');
    return { point, hasBeenActive };
  }
  throw new Error(
    'No neutral activation point is available without clicking an interactive control',
  );
}

const browserOptions: PersistentContextOptions = {
  channel: 'chromium',
  headless: true,
  permissions: [],
  viewport: { width: 1280, height: 900 },
  timeout: 30_000,
};

try {
  await mkdir(evidencePath, { recursive: true });
  const requested = new URL(process.env.LIVE_MEET_URL ?? '');
  assert.equal(
    requested.origin,
    'https://meet.google.com',
    'Only Google Meet HTTPS URLs are allowed',
  );
  assert.ok(requested.pathname.startsWith('/meet/'), 'The requested path must start with /meet/');
  assert.equal(requested.username + requested.password, '', 'URL credentials are not allowed');
  report.requestedUrl = urlWithoutQuery(requested.href);
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')) as {
    name: string;
    version: string;
    content_scripts?: unknown[];
  };
  report.extension = {
    name: manifest.name,
    version: manifest.version,
    contentScripts: manifest.content_scripts,
  };
  profilePath = await mkdtemp(join(tmpdir(), 'mtg-harness-live-'));
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
  const livePage = await context.newPage();
  page = livePage;
  livePage.on('framenavigated', (frame) => {
    if (frame === livePage.mainFrame()) {
      report.urlTransitions.push(urlWithoutQuery(frame.url()));
    }
  });
  const response = await livePage.goto(requested.href, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  report.httpStatus = response?.status();
  await livePage.waitForTimeout(5_000);
  report.finalUrl = urlWithoutQuery(livePage.url());
  report.finalPath = new URL(livePage.url()).pathname;
  report.title = (await livePage.title()).slice(0, 300);
  report.pageTextExcerpt = (await livePage.locator('body').innerText())
    .replace(/\s+/g, ' ')
    .slice(0, 500);
  await livePage.screenshot({ path: join(evidencePath, 'live-meet.png') });

  const current = new URL(livePage.url());
  if (current.origin !== requested.origin || !current.pathname.startsWith('/meet/')) {
    report.outcome = 'redirected_outside_scope';
    throw new Error('The live page redirected outside the configured /meet/ scope');
  }

  report.userActivation = await activateNeutral(livePage);
  const loadedUrl = livePage.url();
  const marker = randomUUID();
  await livePage.evaluate((value) => {
    (window as SmokeWindow).__mtgHarnessSmokeMarker = value;
  }, marker);
  await closeWithDialog(livePage, 'dismiss');
  assert.equal(livePage.isClosed(), false);
  assert.equal(livePage.url(), loadedUrl);
  assert.equal(
    await livePage.evaluate(() => (window as SmokeWindow).__mtgHarnessSmokeMarker),
    marker,
  );
  report.checks.cancelKeepsTabAndDocument = true;
  await livePage.screenshot({ path: join(evidencePath, 'live-meet.png') });
  await closeWithDialog(livePage, 'accept');
  assert.equal(livePage.isClosed(), true);
  report.checks.secondConfirmationAndApprovedClose = true;

  // A fresh control profile checks whether the site already prompts by itself.
  const control: ControlReport = { extensionEnabled: false, dialogTypes: [] };
  report.control = control;
  controlProfilePath = await mkdtemp(join(tmpdir(), 'mtg-harness-live-control-'));
  controlContext = await chromium.launchPersistentContext(controlProfilePath, {
    ...browserOptions,
    args: ['--deny-permission-prompts'],
  });
  controlContext.setDefaultTimeout(10_000);
  const controlPage = await controlContext.newPage();
  await controlPage.goto(requested.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await controlPage.waitForTimeout(5_000);
  control.finalUrl = urlWithoutQuery(controlPage.url());
  control.title = (await controlPage.title()).slice(0, 300);
  await controlPage.screenshot({ path: join(evidencePath, 'live-meet-control.png') });
  assert.equal(
    control.finalUrl,
    report.finalUrl,
    'Control and extension browsers reached different final URLs',
  );
  control.userActivation = await activateNeutral(controlPage);
  const controlDialogTasks: Promise<void>[] = [];
  controlPage.on('dialog', (dialog) => {
    control.dialogTypes.push(dialog.type());
    const task = dialog.accept();
    controlDialogTasks.push(task);
    task.catch(() => {});
  });
  await Promise.all([
    controlPage.waitForEvent('close', { timeout: 8_000 }),
    controlPage.close({ runBeforeUnload: true }),
  ]);
  await Promise.all(controlDialogTasks);
  control.sitePromptsWithoutExtension = control.dialogTypes.includes('beforeunload');
  report.extensionAttribution = control.sitePromptsWithoutExtension
    ? 'inconclusive-site-also-prompts'
    : 'prompt-observed-only-with-extension';
  report.outcome = 'passed';
} catch (error) {
  // Keep only our error message, not Playwright call logs with possible auth URLs.
  const message = error instanceof Error ? error.message : String(error);
  report.error = (message.split('\n')[0] ?? '').replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      return urlWithoutQuery(url);
    } catch {
      return '[URL]';
    }
  });
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    await bounded(
      page.screenshot({ path: join(evidencePath, 'live-meet.png') }),
      5_000,
      'Failure screenshot',
    ).catch(() => {});
  }
} finally {
  for (const browserContext of [context, controlContext]) {
    if (!browserContext) continue;
    await bounded(browserContext.close(), 10_000, 'Browser cleanup').catch((error: unknown) => {
      report.cleanupError = error instanceof Error ? error.message : String(error);
      if (report.outcome === 'passed') report.outcome = 'failed_cleanup';
      cleanupTimedOut = true;
      process.exitCode = 1;
    });
  }
  for (const profile of [profilePath, controlProfilePath]) {
    if (!profile) continue;
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(evidencePath, { recursive: true });
  await writeFile(join(evidencePath, 'live-meet.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (cleanupTimedOut) process.exit(1);
}
