// Background script shared by Safari, Chrome and Firefox (Manifest V3).
//
// Toolbar/menu click → inject dirt-core.js and inject.js into the active tab. `activeTab` grants
// access to the current page for that click; on the same click we also ask, once per site, for
// permission to run on that site in future, so a saved garden can come back at page load with no
// click. The ask uses the browser's own per-site prompt; nothing is requested at install.
//
// Saved gardens: when a burial finishes, the content script sends the exported scene here and it
// is kept in storage.local under the page's URL (hash stripped). autorestore.js asks for it at
// page load on allowed sites; inject.js asks for it on a click. Nothing is sent anywhere.
const api = globalThis.browser ?? globalThis.chrome;

function gardenKey(url) {
  try { const u = new URL(url); return 'garden:' + u.origin + u.pathname + u.search; }
  catch { return 'garden:' + url; }
}

function sitePattern(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.hostname}/*` : null; }
  catch { return null; }
}

api.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  // permissions.request must run inside the click's user gesture, before any await.
  const pattern = sitePattern(tab.url || '');
  const ask = pattern && api.permissions && api.permissions.request
    ? api.permissions.request({ origins: [pattern] }).catch(() => false)
    : Promise.resolve(false);
  ask.then(async (granted) => {
    try {
      const key = gardenKey(tab.url || '');
      const saved = (await api.storage.local.get(key))[key] || null;
      const target = { tabId: tab.id };
      await api.scripting.executeScript({ target, files: ['dirt-core.js'] });
      await api.scripting.executeScript({ target, func: (s, g) => { globalThis.__dirtSaved = s; globalThis.__dirtSiteAllowed = g; }, args: [saved, !!granted] });
      await api.scripting.executeScript({ target, files: ['inject.js'] });
    } catch (err) {
      // Typical causes: browser-internal pages, the extension gallery, or a site the user has not
      // granted access to (Safari asks per site the first time).
      console.warn('[dirt] inject failed:', err && err.message);
    }
  });
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'dirt:save' && msg.url && msg.data) {
    api.storage.local.set({ [gardenKey(msg.url)]: msg.data }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'dirt:lookup' && msg.url) {
    const key = gardenKey(msg.url);
    api.storage.local.get(key).then(r => sendResponse(r[key] || null));
    return true;
  }
  if (msg.type === 'dirt:capture') {
    // Picture of the visible tab, garden included. Allowed by activeTab (after a click) or by the
    // site permission granted on the first bury; when neither applies the core falls back to a
    // picture of the garden alone. The image goes back to the page's content script and nowhere else.
    const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
    api.tabs.captureVisibleTab(windowId, { format: 'png' }).then(u => sendResponse(u || null), () => sendResponse(null));
    return true;
  }
  if (msg.type === 'dirt:forget' && msg.url) {
    api.storage.local.remove(gardenKey(msg.url)).then(() => sendResponse({ ok: true }));
    return true;
  }
});
