// Content script, runs at page load on sites the reader has allowed (see background.js).
// One message to the background: is there a saved garden for this URL? If so, restore it,
// silently (no HUD). If not, the background may answer with spill-over: a thin layer of dirt
// because a page earlier in this tab was buried. Nothing here reads or changes the host page; if
// there is neither, nothing is drawn and dirt-core.js stays inert.
(function () {
  if (typeof Dirt === 'undefined' || typeof DirtExt === 'undefined') return;
  if (window !== window.top) return;
  DirtExt.api.runtime.sendMessage({ type: 'dirt:lookup', url: location.href })
    .then((res) => {
      if (!res || Dirt.phase !== 'idle') return;
      if (res.garden) { Dirt.restore(res.garden, { debug: false, capture: DirtExt.capture, onAlbum: DirtExt.openAlbum }); return; }
      if (res.spill) {
        // dirt only, proportionally quicker, no buttons: a trace, not a garden
        const f = res.spill.fill;
        Dirt.start({ biome: res.spill.biome, flora: 'none', fill: [f, f], buryMs: Math.max(3000, Math.round(20000 * f / 0.42)), shareButton: false, debug: false });
      }
    })
    .catch(() => {});
})();
