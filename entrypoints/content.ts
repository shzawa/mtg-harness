import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  runAt: 'document_start',
  allFrames: false,
  main(ctx) {
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
