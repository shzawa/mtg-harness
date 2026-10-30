import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionPath = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url));
const fixture = `<!doctype html>
<html lang="en"><head><title>Meet guard fixture</title></head>
<body><button id="interact">Interact with this page</button></body></html>`;
const eventTimeout = 5_000;
let context;
let profilePath;
let keeperPage;

async function openPage(url, { interact = true } = {}) {
  const page = await context.newPage();
  await page.goto(url);
  if (interact) await page.locator('#interact').click();
  return page;
}

async function closeWithConfirmation(page, decision) {
  // runBeforeUnload returns before the tab closes, and cancellation keeps it open.
  // Register both events before asking the browser to close the tab.
  const closed = decision === 'accept'
    ? page.waitForEvent('close', { timeout: eventTimeout })
    : Promise.resolve();
  const handledDialog = page.waitForEvent('dialog', { timeout: eventTimeout })
    .then(async (dialog) => {
      const type = dialog.type();
      await dialog[decision]();
      assert.equal(type, 'beforeunload');
    });

  await Promise.all([
    closed,
    handledDialog,
    page.close({ runBeforeUnload: true }),
  ]);

  assert.equal(page.isClosed(), decision === 'accept');
  if (decision === 'dismiss') {
    assert.equal(await page.title(), 'Meet guard fixture');
  }
}

async function closeWithoutConfirmation(page) {
  const dialogs = [];
  // Resolve an unexpected dialog so a failing assertion cannot leave the tab stuck.
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.accept();
  });
  const closed = page.waitForEvent('close', { timeout: eventTimeout });
  await Promise.all([closed, page.close({ runBeforeUnload: true })]);
  assert.deepEqual(dialogs, [], 'The extension must not request confirmation here');
}

async function cancelNavigation(page, triggerNavigation) {
  const handledDialog = page.waitForEvent('dialog', { timeout: eventTimeout })
    .then(async (dialog) => {
      const type = dialog.type();
      await dialog.dismiss();
      assert.equal(type, 'beforeunload');
    });
  // Trigger the document API directly: a canceled navigation has no load event
  // for page.reload()/page.goto() to wait for. Unexpected failures still reject.
  await Promise.all([handledDialog, triggerNavigation()]);
}

describe('Meet Tab Guard built Chrome extension', { concurrency: false }, () => {
  before(async () => {
    await access(join(extensionPath, 'manifest.json'));
    profilePath = await mkdtemp(join(tmpdir(), 'meet-tab-guard-e2e-'));
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    // Keep one blank tab open while tests exercise closing their own tabs.
    keeperPage = context.pages()[0] ?? await context.newPage();
    context.setDefaultTimeout(eventTimeout);
    // Serve controlled documents at realistic URLs; never contact Google Meet.
    await context.route('https://**/*', (route) => route.fulfill({
      contentType: 'text/html',
      body: fixture,
    }));
  }, { timeout: 30_000 });

  afterEach(async () => {
    if (context) {
      await Promise.all(context.pages().filter((page) => page !== keeperPage).map((page) => page.close()));
    }
  });

  after(async () => {
    try {
      await context?.close();
    } finally {
      if (profilePath) await rm(profilePath, { recursive: true, force: true });
    }
  });

  it('keeps a protected tab on cancel, asks again, then closes on approval', { timeout: 15_000 }, async () => {
    const page = await openPage('https://meet.google.com/meet/example?authuser=1#section');
    await closeWithConfirmation(page, 'dismiss');
    await closeWithConfirmation(page, 'accept');
  });

  it('also allows canceling reload and cross-document navigation', { timeout: 15_000 }, async () => {
    const url = 'https://meet.google.com/meet/';
    const page = await openPage(url);
    await page.evaluate(() => { window.fixtureMarker = 'original document'; });

    await cancelNavigation(page, () => page.evaluate(() => window.location.reload()));
    assert.equal(page.url(), url);
    assert.equal(await page.evaluate(() => window.fixtureMarker), 'original document');

    await cancelNavigation(page, () => page.evaluate(() => window.location.assign('https://example.com/away')));
    assert.equal(page.url(), url);
    assert.equal(await page.evaluate(() => window.fixtureMarker), 'original document');
  });

  it('does not protect the home page, ordinary meetings, /meet, or another origin', { timeout: 20_000 }, async () => {
    for (const url of [
      'https://meet.google.com/',
      'https://meet.google.com/abc-defg-hij',
      'https://meet.google.com/meet',
      'https://example.com/meet/example',
    ]) {
      await closeWithoutConfirmation(await openPage(url));
    }
  });

  it('uses the current URL after SPA transitions into and out of /meet/', { timeout: 15_000 }, async () => {
    const page = await openPage('https://meet.google.com/');
    await page.evaluate(() => history.pushState({}, '', '/meet/from-spa?authuser=1#section'));
    await closeWithConfirmation(page, 'dismiss');

    await page.evaluate(() => history.replaceState({}, '', '/abc-defg-hij'));
    await closeWithoutConfirmation(page);
  });

  it('does not show a dialog before the page has received a user interaction', { timeout: 10_000 }, async () => {
    const page = await openPage('https://meet.google.com/meet/no-interaction', { interact: false });
    await closeWithoutConfirmation(page);
  });
});
