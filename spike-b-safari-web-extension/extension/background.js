// Spike B — background script shared by Safari, Chrome and Firefox (Manifest V3).
// Toolbar/menu click → inject dirt-core.js + inject.js into the active tab. `activeTab` grants
// access to the current page only on that click; no host permissions are requested.
const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['dirt-core.js', 'inject.js']
    });
  } catch (err) {
    // Typical causes: browser-internal pages, the extension gallery, or a site the user has not
    // granted access to (Safari asks per site the first time).
    console.warn('[dirt] inject failed:', err && err.message);
  }
});
