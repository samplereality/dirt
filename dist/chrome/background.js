// Background script shared by Safari, Chrome and Firefox (Manifest V3).
//
// Toolbar/menu click → inject dirt-core.js and inject.js into the active tab. `activeTab` grants
// access to the current page for that click; on the same click we also ask, once per site, for
// permission to run on that site in future, so a saved garden can come back at page load with no
// click. The ask uses the browser's own per-site prompt; nothing is requested at install.
//
// Storage (all in storage.local, all on this device, nothing sent anywhere):
//   garden:<url>  the exported scene            thumb:<url>  a small JPEG data URL
//   album:index   [{url, title, host, biome, fill, savedAt}] newest first
const api = globalThis.browser ?? globalThis.chrome;

function gardenKey(url) {
  try { const u = new URL(url); return 'garden:' + u.origin + u.pathname + u.search; }
  catch { return 'garden:' + url; }
}
const thumbKey = url => 'thumb:' + gardenKey(url).slice(7);
const INDEX = 'album:index';

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
      await api.scripting.executeScript({ target, files: ['dirt-core.js', 'shared.js'] });
      await api.scripting.executeScript({ target, func: (s, g) => { globalThis.__dirtSaved = s; globalThis.__dirtSiteAllowed = g; }, args: [saved, !!granted] });
      await api.scripting.executeScript({ target, files: ['inject.js'] });
    } catch (err) {
      // Typical causes: browser-internal pages, the extension gallery, or a site the user has not
      // granted access to (Safari asks per site the first time).
      console.warn('[dirt] inject failed:', err && err.message);
    }
  });
});

async function saveGarden({ url, data, thumb, title }) {
  const gk = gardenKey(url), tk = thumbKey(url);
  const put = { [gk]: data };
  if (thumb) put[tk] = thumb;
  const index = ((await api.storage.local.get(INDEX))[INDEX] || []).filter(e => e.key !== gk);
  let host = ''; try { host = new URL(url).hostname; } catch { /* keep empty */ }
  index.unshift({ key: gk, url, title: (title || '').slice(0, 120), host, biome: data.biome, fill: data.fill, savedAt: data.savedAt || Date.now(), hasThumb: !!thumb });
  put[INDEX] = index;
  await api.storage.local.set(put);
}

async function forgetGarden(url) {
  const gk = gardenKey(url);
  const index = ((await api.storage.local.get(INDEX))[INDEX] || []).filter(e => e.key !== gk);
  await api.storage.local.remove([gk, thumbKey(url)]);
  await api.storage.local.set({ [INDEX]: index });
}

async function forgetAll() {
  const all = await api.storage.local.get(null);
  await api.storage.local.remove(Object.keys(all).filter(k => /^(garden|thumb):/.test(k) || k === INDEX));
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const reply = (p) => p.then(v => sendResponse(v === undefined ? { ok: true } : v), e => sendResponse({ ok: false, error: e && e.message }));
  switch (msg.type) {
    case 'dirt:save': if (msg.url && msg.data) { reply(saveGarden(msg)); return true; } break;
    case 'dirt:lookup': { const k = gardenKey(msg.url || ''); reply(api.storage.local.get(k).then(r => r[k] || null)); return true; }
    case 'dirt:forget': reply(forgetGarden(msg.url || '')); return true;
    case 'dirt:forget-all': reply(forgetAll()); return true;
    case 'dirt:list': reply(api.storage.local.get(INDEX).then(r => r[INDEX] || [])); return true;
    case 'dirt:thumb': { const k = thumbKey(msg.url || ''); reply(api.storage.local.get(k).then(r => r[k] || null)); return true; }
    case 'dirt:album': reply(api.tabs.create({ url: api.runtime.getURL('album.html') })); return true;
    case 'dirt:capture': {
      // Picture of the visible tab, garden included, only if the asking tab is the one in front
      // (otherwise we'd photograph some other tab). Allowed by activeTab after a click; when the
      // browser refuses, the content script falls back to a picture of the garden alone.
      if (!sender || !sender.tab || !sender.tab.active) { sendResponse(null); return; }
      api.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }).then(u => sendResponse(u || null), () => sendResponse(null));
      return true;
    }
  }
});
