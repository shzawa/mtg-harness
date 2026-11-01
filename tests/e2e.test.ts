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
function chatFixture(language: 'ja' | 'en' = 'en', hidden = true): string {
  return fixture.replace('<html lang="en">', `<html lang="${language}">`).replace(
    '</body>',
    `
    <button id="leave" aria-label="${language === 'ja' ? '通話から退出' : 'Leave call'}">Leave</button>
    <div id="toolbar" ${hidden ? 'hidden' : ''}>
      <button id="native-chat" aria-label="${language === 'ja' ? '全員とチャット' : 'Chat with everyone'}"
        data-clicks="0" onclick="this.dataset.clicks = Number(this.dataset.clicks) + 1;
          document.querySelector('#chat-panel').hidden = !document.querySelector('#chat-panel').hidden">Chat</button>
    </div><div id="chat-panel" hidden>Meeting chat</div></body>`,
  );
}
const eventTimeout = 5_000;
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
  it('provides a keyboard-accessible replacement for a hidden native chat button in Japanese and English', async () => {
    for (const language of ['ja', 'en'] as const) {
      const page = await openPage('https://meet.google.com/meet/chat', {
        html: chatFixture(language),
      });
      const button = page.locator('#mtg-harness-chat button');
      await button.waitFor();
      expect(await button.textContent()).toBe(language === 'ja' ? 'チャット' : 'Chat');
      await button.click();
      expect(await page.locator('#chat-panel').isVisible()).toBe(true);
      await button.focus();
      await page.keyboard.press('Enter');
      expect(await page.locator('#chat-panel').isVisible()).toBe(false);
      expect(await page.locator('#native-chat').getAttribute('data-clicks')).toBe('2');
      await closeWithConfirmation(page, 'accept');
    }
  }, 20_000);

  it('shows and removes the replacement when responsive styles hide and restore the native button', async () => {
    const page = await openPage('https://meet.google.com/meet/responsive-chat', {
      html: chatFixture('en', false).replace(
        '</head>',
        '<style>@media (max-width: 700px) { #toolbar { display: none; } }</style></head>',
      ),
    });
    await page.waitForTimeout(600);
    expect(await page.locator('#mtg-harness-chat').count()).toBe(0);
    await page.setViewportSize({ width: 640, height: 720 });
    await page.locator('#mtg-harness-chat button').click();
    expect(await page.locator('#chat-panel').isVisible()).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(() => page.locator('#mtg-harness-chat').count()).toBe(0);
  });

  it('handles hidden ancestors, transparent controls, and offscreen controls', async () => {
    for (const style of ['visibility:hidden', 'opacity:0', 'position:fixed;left:-1000px']) {
      const page = await openPage('https://meet.google.com/meet/hidden-chat', {
        html: chatFixture('en', false).replace('id="toolbar"', `id="toolbar" style="${style}"`),
      });
      await page.locator('#mtg-harness-chat button').click();
      expect(await page.locator('#native-chat').getAttribute('data-clicks')).toBe('1');
      await page.close();
    }
  });

  it('uses the current native control after replacement and does not duplicate the fallback', async () => {
    const page = await openPage('https://meet.google.com/meet/replaced-chat', {
      html: chatFixture(),
    });
    const button = page.locator('#mtg-harness-chat button');
    await button.waitFor();
    await page.evaluate(() => {
      const native = document.querySelector('#native-chat');
      if (!native) throw new Error('Missing native chat control');
      native.replaceWith(native.cloneNode(true));
    });
    await button.click();
    expect(await page.locator('#native-chat').getAttribute('data-clicks')).toBe('1');
    await page.waitForTimeout(600);
    expect(await page.locator('#mtg-harness-chat').count()).toBe(1);
    await page.evaluate(() => document.querySelector('#native-chat')?.remove());
    await expect.poll(() => page.locator('#mtg-harness-chat').count()).toBe(0);
  });

  it('does not offer unavailable chat controls, prejoin controls, or unrelated pages', async () => {
    for (const html of [
      chatFixture().replace('id="native-chat"', 'id="native-chat" disabled'),
      chatFixture().replace('id="native-chat"', 'id="native-chat" aria-disabled="true"'),
      chatFixture().replace('aria-label="Leave call"', 'aria-label="Join now"'),
    ]) {
      const page = await openPage('https://meet.google.com/meet/unavailable-chat', { html });
      await page.waitForTimeout(600);
      expect(await page.locator('#mtg-harness-chat').count()).toBe(0);
      await page.close();
    }
    for (const url of [
      'https://meet.google.com/abc-defg-hij',
      'https://example.com/meet/example',
    ]) {
      const page = await openPage(url, { html: chatFixture() });
      await page.waitForTimeout(600);
      expect(await page.locator('#mtg-harness-chat').count()).toBe(0);
      await page.close();
    }
  });

  it('removes the replacement after leaving the call or navigating outside the target URL', async () => {
    const page = await openPage('https://meet.google.com/meet/leaving-chat', {
      html: chatFixture(),
    });
    await page.locator('#mtg-harness-chat button').waitFor();
    await page.evaluate(() => history.pushState({}, '', '/outside'));
    await expect.poll(() => page.locator('#mtg-harness-chat').count()).toBe(0);
    await page.evaluate(() => history.pushState({}, '', '/meet/rejoined'));
    await page.locator('#mtg-harness-chat button').waitFor();
    await page.evaluate(() => document.querySelector('#leave')?.remove());
    await expect.poll(() => page.locator('#mtg-harness-chat').count()).toBe(0);
  });
});
