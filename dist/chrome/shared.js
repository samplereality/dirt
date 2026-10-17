// Helpers shared by inject.js and autorestore.js (content-script world).
const DirtExt = (() => {
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

  return { api, capture, openAlbum, thumbnail, saveCurrent };
})();
