// Background script shared by Safari, Chrome and Firefox (Manifest V3).
//
// Toolbar/menu click → inject dirt-core.js and inject.js into the active tab. `activeTab` grants
// access to the current page only on that click; no host permissions are requested.
//
// Saved gardens: when a burial finishes, the content script sends the exported scene here and it
// is kept in storage.local under the page's URL (hash stripped). On the next click on that page,
// the saved scene is handed to inject.js, which restores it instead of burying afresh.
// Everything stays in this browser's extension storage; nothing is sent anywhere.
const api = globalThis.browser ?? globalThis.chrome;

function gardenKey(url) {
  try { const u = new URL(url); return 'garden:' + u.origin + u.pathname + u.search; }
  catch { return 'garden:' + url; }
}

api.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    const key = gardenKey(tab.url || '');
    const saved = (await api.storage.local.get(key))[key] || null;
    const target = { tabId: tab.id };
    await api.scripting.executeScript({ target, files: ['dirt-core.js'] });
    await api.scripting.executeScript({ target, func: (s) => { globalThis.__dirtSaved = s; }, args: [saved] });
    await api.scripting.executeScript({ target, files: ['inject.js'] });
  } catch (err) {
    // Typical causes: browser-internal pages, the extension gallery, or a site the user has not
    // granted access to (Safari asks per site the first time).
    console.warn('[dirt] inject failed:', err && err.message);
  }
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'dirt:save' && msg.url && msg.data) {
    api.storage.local.set({ [gardenKey(msg.url)]: msg.data }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'dirt:forget' && msg.url) {
    api.storage.local.remove(gardenKey(msg.url)).then(() => sendResponse({ ok: true }));
    return true;
  }
});
