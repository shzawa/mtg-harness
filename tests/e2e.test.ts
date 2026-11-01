import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { BrowserContext, Dialog, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

type DialogDecision = 'accept' | 'dismiss';
type FixtureWindow = Window & { fixtureMarker?: string };

const extensionPath = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url));
const fixture = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Meet guard fixture</title></head>
<body><button id="interact">Interact with this page</button></body></html>`;
const eventTimeout = 5_000;
function prejoinFixture(language: 'ja' | 'en', muted = false): string {
  const labels =
    language === 'ja'
      ? [
          ['マイクをオフにする', 'マイクをオンにする'],
          ['カメラをオフにする', 'カメラをオンにする'],
        ]
      : [
          ['Turn off microphone', 'Turn on microphone'],
          ['Turn off camera', 'Turn on camera'],
        ];
  return fixture.replace(
    '</body>',
    `${labels
      .map(
        ([on, off], index) =>
          `<button id="device-${index}" aria-label="${muted ? off : on}" data-clicks="0"
      onclick="this.dataset.clicks = Number(this.dataset.clicks) + 1;
        this.setAttribute('aria-label', this.getAttribute('aria-label') === '${on}' ? '${off}' : '${on}')">Device</button>`,
      )
      .join(
        '',
      )}<button id="join">${language === 'ja' ? '今すぐ参加' : 'Ask to join'}</button></body>`,
  );
}
let context: BrowserContext | undefined;
let profilePath: string | undefined;
let keeperPage: Page | undefined;

async function openPage(
  url: string,
  { interact = true, html }: { interact?: boolean; html?: string } = {},
): Promise<Page> {
  if (!context) throw new Error('The test browser context has not been initialized');
  const page = await context.newPage();
  if (html !== undefined) {
    await page.route('https://**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
  }
  await page.goto(url);
  if (interact) await page.locator('#interact').click();
  return page;
}

async function closeWithConfirmation(page: Page, decision: DialogDecision): Promise<void> {
  // runBeforeUnload returns before the tab closes, and cancellation keeps it open.
  // Register both events before asking the browser to close the tab.
  const closed =
    decision === 'accept'
      ? page.waitForEvent('close', { timeout: eventTimeout })
      : Promise.resolve();
  const handledDialog = page
    .waitForEvent('dialog', { timeout: eventTimeout })
    .then(async (dialog) => {
      const type = dialog.type();
      await dialog[decision]();
      expect(type).toBe('beforeunload');
    });

  await Promise.all([closed, handledDialog, page.close({ runBeforeUnload: true })]);

  expect(page.isClosed()).toBe(decision === 'accept');
  if (decision === 'dismiss') {
    expect(await page.title()).toBe('Meet guard fixture');
  }
}

async function closeWithoutConfirmation(page: Page): Promise<void> {
  const dialogs: ReturnType<Dialog['type']>[] = [];
  // Resolve an unexpected dialog so a failing assertion cannot leave the tab stuck.
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.accept();
  });
  const closed = page.waitForEvent('close', { timeout: eventTimeout });
  await Promise.all([closed, page.close({ runBeforeUnload: true })]);
  expect(dialogs, 'The extension must not request confirmation here').toEqual([]);
}

async function cancelNavigation(
  page: Page,
  triggerNavigation: () => Promise<unknown>,
): Promise<void> {
  const handledDialog = page
    .waitForEvent('dialog', { timeout: eventTimeout })
    .then(async (dialog) => {
      const type = dialog.type();
      await dialog.dismiss();
      expect(type).toBe('beforeunload');
    });
  // Trigger the document API directly: a canceled navigation has no load event
  // for page.reload()/page.goto() to wait for. Unexpected failures still reject.
  await Promise.all([handledDialog, triggerNavigation()]);
}

describe('MTG Harness built Chrome extension', { concurrent: false }, () => {
  beforeAll(async () => {
    await access(join(extensionPath, 'manifest.json'));
    profilePath = await mkdtemp(join(tmpdir(), 'mtg-harness-e2e-'));
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    // Keep one blank tab open while tests exercise closing their own tabs.
    keeperPage = context.pages()[0] ?? (await context.newPage());
    context.setDefaultTimeout(eventTimeout);
    // Serve controlled documents at realistic URLs; never contact Google Meet.
    await context.route('https://**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: fixture,
      }),
    );
  }, 30_000);

  afterEach(async () => {
    if (context) {
      await Promise.all(
        context
          .pages()
          .filter((page) => page !== keeperPage)
          .map((page) => page.close()),
      );
    }
  });

  afterAll(async () => {
    try {
      await context?.close();
    } finally {
      if (profilePath) await rm(profilePath, { recursive: true, force: true });
    }
  });

  it('keeps a protected tab on cancel, asks again, then closes on approval', async () => {
    const page = await openPage('https://meet.google.com/meet/example?authuser=1#section');
    await closeWithConfirmation(page, 'dismiss');
    await closeWithConfirmation(page, 'accept');
  }, 15_000);

  it('mutes the microphone and camera before joining in Japanese and English', async () => {
    for (const language of ['ja', 'en'] as const) {
      const page = await openPage('https://meet.google.com/meet/prejoin', {
        html: prejoinFixture(language),
      });
      for (const index of [0, 1]) {
        await expect
          .poll(() => page.locator(`#device-${index}`).getAttribute('data-clicks'))
          .toBe('1');
      }
      // The new feature must preserve the existing close protection.
      await closeWithConfirmation(page, 'accept');
    }
  }, 20_000);

  it('leaves already-muted devices and later manual choices alone', async () => {
    const page = await openPage('https://meet.google.com/meet/muted', {
      html: prejoinFixture('ja', true),
    });
    await page.waitForTimeout(600);
    for (const index of [0, 1]) {
      expect(await page.locator(`#device-${index}`).getAttribute('data-clicks')).toBe('0');
      await page.locator(`#device-${index}`).click();
    }
    await page.waitForTimeout(600);
    for (const index of [0, 1]) {
      expect(await page.locator(`#device-${index}`).getAttribute('data-clicks')).toBe('1');
    }
  });

  it('waits for late controls, ignores hidden and disabled controls, and mutes again on rejoin', async () => {
    const page = await openPage('https://meet.google.com/meet/late-controls', {
      html: prejoinFixture('en').replace('id="join"', 'id="join" hidden'),
    });
    await page.waitForTimeout(600);
    expect(await page.locator('#device-0').getAttribute('data-clicks')).toBe('0');
    await page.evaluate(() => {
      document.querySelector('#join')?.removeAttribute('hidden');
      document.querySelector('#device-1')?.setAttribute('disabled', '');
    });
    await expect.poll(() => page.locator('#device-0').getAttribute('data-clicks')).toBe('1');
    expect(await page.locator('#device-1').getAttribute('data-clicks')).toBe('0');
    await page.evaluate(() => document.querySelector('#device-1')?.removeAttribute('disabled'));
    await expect.poll(() => page.locator('#device-1').getAttribute('data-clicks')).toBe('1');
    await page.evaluate(() => {
      document.querySelector('#join')?.setAttribute('hidden', '');
      document.body.insertAdjacentHTML(
        'beforeend',
        '<button id="leave" aria-label="Leave call">Leave</button>',
      );
    });
    await page.locator('#device-0').click();
    await page.waitForTimeout(600);
    expect(await page.locator('#device-0').getAttribute('data-clicks')).toBe('2');
    await page.evaluate(() => {
      document.querySelector('#leave')?.remove();
      document.querySelector('#join')?.removeAttribute('hidden');
    });
    await expect.poll(() => page.locator('#device-0').getAttribute('data-clicks')).toBe('3');
  }, 15_000);

  it('does not mute devices outside the target URL or without a visible join button', async () => {
    for (const url of [
      'https://meet.google.com/abc-defg-hij',
      'https://example.com/meet/example',
    ]) {
      const page = await openPage(url, { html: prejoinFixture('en') });
      await page.waitForTimeout(600);
      expect(await page.locator('#device-0').getAttribute('data-clicks')).toBe('0');
    }
  });

  it('also allows canceling reload and cross-document navigation', async () => {
    const url = 'https://meet.google.com/meet/';
    const page = await openPage(url);
    await page.evaluate(() => {
      (window as FixtureWindow).fixtureMarker = 'original document';
    });

    await cancelNavigation(page, () => page.evaluate(() => window.location.reload()));
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => (window as FixtureWindow).fixtureMarker)).toBe(
      'original document',
    );

    await cancelNavigation(page, () =>
      page.evaluate(() => window.location.assign('https://example.com/away')),
    );
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => (window as FixtureWindow).fixtureMarker)).toBe(
      'original document',
    );
  }, 15_000);

  it('does not protect the home page, ordinary meetings, /meet, or another origin', async () => {
    for (const url of [
      'https://meet.google.com/',
      'https://meet.google.com/abc-defg-hij',
      'https://meet.google.com/meet',
      'https://example.com/meet/example',
    ]) {
      await closeWithoutConfirmation(await openPage(url));
    }
  }, 20_000);

  it('uses the current URL after SPA transitions into and out of /meet/', async () => {
    const page = await openPage('https://meet.google.com/');
    await page.evaluate(() => history.pushState({}, '', '/meet/from-spa?authuser=1#section'));
    await closeWithConfirmation(page, 'dismiss');

    await page.evaluate(() => history.replaceState({}, '', '/abc-defg-hij'));
    await closeWithoutConfirmation(page);
  }, 15_000);

  it('does not show a dialog before the page has received a user interaction', async () => {
    const page = await openPage('https://meet.google.com/meet/no-interaction', { interact: false });
    await closeWithoutConfirmation(page);
  }, 10_000);

  it('allows closing a newly loaded document with the visible Japanese left-meeting heading', async () => {
    const page = await openPage('https://meet.google.com/meet/already-left', {
      html: fixture.replace(
        '</body>',
        '<h1 style="white-space: pre"> \n<span>ミーティングから退出しました</span>\n </h1></body>',
      ),
    });
    expect(await page.locator('h1').textContent()).toContain('ミーティングから退出しました');
    await closeWithoutConfirmation(page);
  }, 15_000);

  it('allows closing after the left-meeting heading appears following a canceled close', async () => {
    const page = await openPage('https://meet.google.com/meet/leave-after-cancel');
    await closeWithConfirmation(page, 'dismiss');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<h1>ミーティングから退出しました</h1>');
    });
    await closeWithoutConfirmation(page);
  }, 15_000);

  it('restores confirmation when the left-meeting heading is removed or replaced on rejoin', async () => {
    const url = 'https://meet.google.com/meet/rejoin';
    for (const change of ['remove', 'replace']) {
      const page = await openPage(url, {
        html: fixture.replace('</body>', '<h1>ミーティングから退出しました</h1></body>'),
      });
      await page.evaluate((change) => {
        const heading = document.querySelector('h1');
        if (!heading) throw new Error('The fixture has no left-meeting heading');
        if (change === 'remove') {
          heading.remove();
        } else {
          const activeHeading = document.createElement('h1');
          activeHeading.textContent = 'ミーティングに参加中';
          heading.replaceWith(activeHeading);
        }
      }, change);
      expect(page.url()).toBe(url);
      await closeWithConfirmation(page, 'accept');
    }
  }, 20_000);

  it('keeps confirmation for non-h1, similar Japanese, and English left-meeting text', async () => {
    for (const heading of [
      '<h2>ミーティングから退出しました</h2>',
      '<h1>ミーティングから退出しました。</h1>',
      '<h1>You left the meeting</h1>',
    ]) {
      const page = await openPage('https://meet.google.com/meet/other-text', {
        html: fixture.replace('</body>', `${heading}</body>`),
      });
      await closeWithConfirmation(page, 'accept');
    }
  }, 20_000);

  it('keeps confirmation when the matching heading or its ancestor is hidden', async () => {
    for (const heading of [
      '<h1 hidden>ミーティングから退出しました</h1>',
      '<h1 style="display: none">ミーティングから退出しました</h1>',
      '<h1 style="visibility: hidden">ミーティングから退出しました</h1>',
      '<div hidden><h1>ミーティングから退出しました</h1></div>',
      '<div style="visibility: hidden"><h1>ミーティングから退出しました</h1></div>',
      '<div style="opacity: 0"><h1>ミーティングから退出しました</h1></div>',
      '<div style="content-visibility: hidden"><h1>ミーティングから退出しました</h1></div>',
    ]) {
      const page = await openPage('https://meet.google.com/meet/hidden-heading', {
        html: fixture.replace('</body>', `${heading}</body>`),
      });
      await closeWithConfirmation(page, 'accept');
    }
  }, 20_000);
});
