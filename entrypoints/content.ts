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

        // During unload, the browser supplies the dialog and its message.
        event.preventDefault();
        event.returnValue = true;
      },
      { capture: true },
    );
  },
});
