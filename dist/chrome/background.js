// Background script shared by Safari, Chrome and Firefox (Manifest V3).
//
// Toolbar/menu click → inject dirt-core.js and inject.js into the active tab. `activeTab` grants
// access to the current page for that click; on the same click we also ask, once per site, for
// permission to run on that site in future, so a saved garden can come back at page load with no
// click. The ask uses the browser's own per-site prompt; nothing is requested at install.
//
// Dirt follows links: from the first shovelful on a page (not just once its garden is finished),
// the next few pages opened in that tab, or in tabs opened from it, get a thinner layer of the
// same dirt and no garden. Answered through the page-load lookup on sites the reader has
// allowed; for the rest, the background injects the same scripts itself when a tab that owes
// spill-over finishes loading (activeTab keeps that possible on the site that was clicked;
// elsewhere the browser may refuse, and the page simply stays clean).
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

// ---- dirt follows links
const SPILL_STEPS = [0.45, 0.22, 0.1];   // fraction of the original fill for the next pages
const spill = new Map();                  // tabId -> { url, fill, biome, used, pages: {url: fill} }

function markBuried(tabId, url, data) {
  if (tabId == null || !data || !(data.fill > 0)) return;
  const key = gardenKey(url), rec = spill.get(tabId);
  if (rec && rec.url === key) { rec.fill = data.fill; rec.biome = data.biome; return; }   // same burial, keep its budget
  spill.set(tabId, { url: key, fill: data.fill, biome: data.biome, used: 0, pages: {} });
}

async function owesSpill(tabId) {
  if (spill.has(tabId)) return true;   // spillFor decides (budget left, or a page seen before)
  try { const tab = await api.tabs.get(tabId); return tab && tab.openerTabId != null && spill.has(tab.openerTabId); }
  catch { return false; }
}

// A tab that owes spill-over finished loading a page: make sure the scripts are there to ask
// for it. On allowed sites the content script already ran (DirtExt is defined) and we stop.
if (api.tabs && api.tabs.onUpdated) api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || (tab.url && !/^https?:/.test(tab.url))) return;
  if (!(await owesSpill(tabId))) return;
  const target = { tabId };
  try {
    const [probe] = await api.scripting.executeScript({ target, func: () => typeof DirtExt !== 'undefined' });
    if (probe && probe.result) return;
    await api.scripting.executeScript({ target, files: ['dirt-core.js', 'shared.js', 'autorestore.js'] });
  } catch { /* no access to this page: it stays clean */ }
});

async function spillFor(tabId, url) {
  let rec = spill.get(tabId);
  if (!rec) {
    // a link opened into a new tab inherits the budget of the tab it came from
    try {
      const tab = await api.tabs.get(tabId);
      if (tab && tab.openerTabId != null && spill.has(tab.openerTabId)) {
        const src = spill.get(tab.openerTabId);
        rec = { url: src.url, fill: src.fill, biome: src.biome, used: src.used, pages: {} };
        spill.set(tabId, rec);
      }
    } catch { /* no opener info */ }
  }
  if (!rec) return null;
  const key = gardenKey(url);
  if (key === rec.url) return null;                    // the buried page itself
  if (rec.pages[key] != null) return { fill: rec.pages[key], biome: rec.biome };   // seen before (back button)
  if (rec.used >= SPILL_STEPS.length) return null;
  const fill = Math.max(0.03, rec.fill * SPILL_STEPS[rec.used++]);
  rec.pages[key] = fill;
  return { fill, biome: rec.biome };
}

if (api.tabs && api.tabs.onRemoved) api.tabs.onRemoved.addListener((tabId) => spill.delete(tabId));

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
    case 'dirt:save': if (msg.url && msg.data) { if (sender && sender.tab) markBuried(sender.tab.id, msg.url, msg.data); reply(saveGarden(msg)); return true; } break;
    case 'dirt:begin':
      // the first shovelful: from now on links out of this tab carry dirt
      if (msg.url && msg.data && sender && sender.tab) markBuried(sender.tab.id, msg.url, msg.data);
      sendResponse({ ok: true }); return;
    case 'dirt:checkpoint':
      // mid-routine snapshot: replaces the garden slot for this URL but is not in the album
      if (msg.url && msg.data && msg.data.partial) {
        if (sender && sender.tab) markBuried(sender.tab.id, msg.url, msg.data);
        reply(api.storage.local.set({ [gardenKey(msg.url)]: msg.data })); return true;
      }
      break;
    case 'dirt:lookup': {
      // page load on an allowed site: a saved garden wins; otherwise maybe some spill-over dirt
      const k = gardenKey(msg.url || ''), tabId = sender && sender.tab ? sender.tab.id : null;
      reply((async () => {
        const garden = (await api.storage.local.get(k))[k] || null;
        if (garden) { markBuried(tabId, msg.url, garden); return { garden }; }
        return { garden: null, spill: tabId != null ? await spillFor(tabId, msg.url) : null };
      })());
      return true;
    }
    case 'dirt:spill-state': {
      // for the album's settings: is all-sites access granted?
      reply(api.permissions && api.permissions.contains ? api.permissions.contains({ origins: ['*://*/*'] }) : Promise.resolve(false));
      return true;
    }
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
