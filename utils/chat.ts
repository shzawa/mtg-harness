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

export function createChatFallback(): { update: () => void; remove: () => void } {
  let host: HTMLDivElement | undefined;

  const remove = () => {
    host?.remove();
    host = undefined;
  };

  const target = () => {
    if (!location.pathname.startsWith('/meet/')) return undefined;
    const buttons = controls();
    if (!buttons.some((button) => hasLabel(button, leaveLabel))) return undefined;
    const candidates = buttons.filter((button) => hasLabel(button, chatLabel));
    // Prefer any visible native control over the extension, including a disabled
    // one. Never expose a hidden duplicate of an available or disabled control.
    if (candidates.some(isVisible)) return undefined;
    return candidates.find((button) => !button.matches(':disabled, [aria-disabled="true"]'));
  };

  const update = () => {
    if (!document.body || !target()) {
      remove();
      return;
    }
    if (host?.isConnected) return;

    host = document.createElement('div');
    host.id = 'mtg-harness-chat';
    host.style.cssText = 'position:fixed;right:16px;bottom:88px;z-index:2147483647;';
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
      const native = target();
      if (!native) {
        update();
        return;
      }
      native.click();
    });
    shadow.append(style, button);
    document.body.append(host);
  };

  return { update, remove };
}
