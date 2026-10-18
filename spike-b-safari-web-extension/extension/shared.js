// Helpers shared by inject.js and autorestore.js (content-script world). Declared with var so the
// file can be injected again into a page where it already ran (a click after page-load restore).
var DirtExt = globalThis.DirtExt || (() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const send = (msg) => api.runtime.sendMessage(msg);

  // Whole-tab picture via the background (null when the browser refuses or the tab is not in front).
  const capture = () => send({ type: 'dirt:capture' }).then(u => u || null).catch(() => null);
  const openAlbum = () => send({ type: 'dirt:album' }).catch(() => {});

  // Scale an image (data URL or Blob) to a small JPEG for the album.
  async function thumbnail(source, width = 320) {
    const img = new Image();
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    try {
      img.src = url; await img.decode();
      const c = document.createElement('canvas');
      c.width = width; c.height = Math.max(1, Math.round(img.naturalHeight * width / img.naturalWidth));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.8);
    } finally { if (typeof source !== 'string') URL.revokeObjectURL(url); }
  }

  // Called when a garden finishes: save the scene plus a thumbnail and the page title.
  async function saveCurrent() {
    const data = Dirt.export();
    if (!data) return;
    let thumb = null;
    try { thumb = await thumbnail((await capture()) || (await Dirt.picture())); } catch { /* thumbnail is optional */ }
    return send({ type: 'dirt:save', url: location.href, data, thumb, title: document.title });
  }

  // The first shovelful is thrown: tell the background, so links followed from here carry dirt
  // even if the reader leaves before the garden is finished.
  function begin() {
    const st = Dirt.stats();
    if (st) send({ type: 'dirt:begin', url: location.href, data: { fill: st.fill, biome: st.biome } }).catch(() => {});
  }

  // While the routine runs, keep a small checkpoint so leaving the page and coming back
  // continues it instead of freezing or starting over. Saved every 2 s and on page hide.
  let ticker = 0;
  function checkpoint() {
    const c = Dirt.checkpoint();
    if (c) send({ type: 'dirt:checkpoint', url: location.href, data: c }).catch(() => {});
  }
  function watch() {
    begin();
    clearInterval(ticker);
    ticker = setInterval(() => { if (Dirt.phase === 'burying' || Dirt.phase === 'growing') checkpoint(); else clearInterval(ticker); }, 2000);
    window.addEventListener('pagehide', checkpoint, { once: false });
  }

  // Standard options for a run started by the extension, with completion wired to the album.
  function opts(extra) {
    return Object.assign({
      capture, onAlbum: openAlbum,
      onPhase: (phase) => { if (phase === 'garden') { clearInterval(ticker); saveCurrent().catch(() => {}); } }
    }, extra || {});
  }

  return { api, capture, openAlbum, thumbnail, saveCurrent, begin, checkpoint, watch, opts };
})();
