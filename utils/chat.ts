const chatLabel = /^(?:全員とチャット|Chat with everyone)(?:\s|（|\(|$)/;
const leaveLabel = /^(?:通話から退出|Leave call)(?:\s|（|\(|$)/;

function controls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
}

function hasLabel(button: HTMLElement, pattern: RegExp): boolean {
  return pattern.test((button.getAttribute('aria-label') ?? button.innerText).trim());
}

function isVisible(button: HTMLElement): boolean {
  if (!button.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
  const rect = button.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}

function toggleChatShortcut(): void {
  // Meet's documented chat shortcut works even when its responsive toolbar
  // removes the native chat button. Dispatch from the page body, not our shadow
  // button or an editable chat field.
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const options: KeyboardEventInit = {
    key: 'c',
    code: 'KeyC',
    keyCode: 67,
    which: 67,
    ctrlKey: true,
    metaKey: mac,
    altKey: !mac,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  document.body.dispatchEvent(new KeyboardEvent('keydown', options));
  document.body.dispatchEvent(new KeyboardEvent('keyup', options));
}

export function createChatFallback(): { update: () => void; remove: () => void } {
  let host: HTMLDivElement | undefined;

  const remove = () => {
    host?.remove();
    host = undefined;
  };

  const fallbackAction = () => {
    if (!location.pathname.startsWith('/meet/')) return undefined;
    const buttons = controls();
    if (!buttons.some((button) => hasLabel(button, leaveLabel) && isVisible(button)))
      return undefined;
    const candidates = buttons.filter((button) => hasLabel(button, chatLabel));
    // Prefer any visible native control over the extension, including a disabled
    // one. Never expose a hidden duplicate of an available or disabled control.
    if (
      candidates.some(
        (button) => isVisible(button) || button.matches(':disabled, [aria-disabled="true"]'),
      )
    )
      return undefined;
    return { native: candidates[0] };
  };

  const update = () => {
    if (!document.body || !fallbackAction()) {
      remove();
      return;
    }
    if (host?.isConnected) return;

    host = document.createElement('div');
    host.id = 'mtg-harness-chat';
    host.style.cssText = 'position:fixed;left:16px;bottom:88px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      button { font: 500 14px system-ui, sans-serif; color: #fff; background: #1a73e8;
        border: 1px solid #fff; border-radius: 24px; padding: 12px 20px; cursor: pointer;
        box-shadow: 0 2px 8px #0006; }
      button:hover { background: #185abc; }
      button:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
    `;
    const button = document.createElement('button');
    button.type = 'button';
    const japanese = document.documentElement.lang.toLowerCase().startsWith('ja');
    button.textContent = japanese ? 'チャット' : 'Chat';
    button.setAttribute(
      'aria-label',
      japanese ? 'チャットを開閉（MTG Harness）' : 'Toggle chat (MTG Harness)',
    );
    button.title = 'MTG Harness';
    button.addEventListener('click', () => {
      // Resolve the current control on every click: Meet can replace its toolbar.
      const action = fallbackAction();
      if (!action) {
        update();
        return;
      }
      if (action.native) action.native.click();
      else toggleChatShortcut();
    });
    shadow.append(style, button);
    document.body.append(host);
  };

  return { update, remove };
}
