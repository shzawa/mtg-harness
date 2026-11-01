import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChatFallback } from '../utils/chat';
import { createPrejoinMuter } from '../utils/prejoin';

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  runAt: 'document_start',
  allFrames: false,
  main(ctx) {
    const chat = createChatFallback();
    chat.update();
    ctx.setInterval(chat.update, 250);
    ctx.onInvalidated(chat.remove);

    const muteBeforeJoining = createPrejoinMuter();
    muteBeforeJoining();
    ctx.setInterval(muteBeforeJoining, 250);

    ctx.addEventListener(
      window,
      'beforeunload',
      (event) => {
        // Evaluate the current URL, including changes made without a reload.
        if (
          window.location.origin !== 'https://meet.google.com' ||
          !window.location.pathname.startsWith('/meet/')
        ) {
          return;
        }

        // Recheck the current screen so rejoining restores protection immediately.
        if (
          Array.from(document.querySelectorAll('h1')).some(
            (heading) =>
              heading.checkVisibility?.({
                visibilityProperty: true,
                opacityProperty: true,
                contentVisibilityAuto: true,
              }) && heading.innerText.trim() === 'ミーティングから退出しました',
          )
        ) {
          return;
        }

        // During unload, the browser supplies the dialog and its message.
        event.preventDefault();
        event.returnValue = true;
      },
      { capture: true },
    );
  },
});
