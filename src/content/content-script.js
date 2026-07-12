/**
 * Content script — a postMessage bridge between the share page and the extension.
 *
 * Injected only on the vibeheader.com share pages (/s*) declared in the manifest.
 * It does exactly one thing: let the share page (share.js) hand-shake with the
 * extension via window.postMessage and trigger an import.
 *
 * Security note: earlier versions also included a legacy `?config=` import dialog
 * and an on-page indicator. Both built DOM with innerHTML from unescaped header
 * values taken from the link, which was a DOM XSS vector. The live share flow only
 * uses the `#c=` + postMessage protocol below and never depended on that code, so
 * it was removed entirely — fixing the XSS with no loss of functionality.
 */
(function initShareBridge() {
  window.addEventListener('message', async (event) => {
    // only accept messages from the same window
    if (event.source !== window) return;
    const msg = event.data || {};

    if (msg.type === 'VIBE_PING') {
      // the share page is probing whether the extension is installed
      window.postMessage({ type: 'VIBE_ACK' }, '*');
      return;
    }

    if (msg.type === 'VIBE_IMPORT' && Array.isArray(msg.h)) {
      try {
        const res = await chrome.runtime.sendMessage({
          action: 'importSharedKV',
          data: { h: msg.h }
        });
        window.postMessage({ type: 'VIBE_RESULT', success: !!res?.success }, '*');
      } catch (e) {
        window.postMessage({ type: 'VIBE_RESULT', success: false, error: e?.message }, '*');
      }
    }
  }, false);
})();
