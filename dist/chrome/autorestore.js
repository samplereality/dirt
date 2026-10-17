// Content script, runs at page load on sites the reader has allowed (see background.js).
// One message to the background: is there a saved garden for this URL? A finished one is
// restored silently; one left mid-routine is continued. If there is none, the background may
// answer with spill-over: a thin, already-settled layer because a page earlier in this tab was
// buried. Nothing here reads or changes the host page; with nothing to show, dirt-core.js stays inert.
(function () {
  if (typeof Dirt === 'undefined' || typeof DirtExt === 'undefined') return;
  if (window !== window.top) return;
  DirtExt.api.runtime.sendMessage({ type: 'dirt:lookup', url: location.href })
    .then((res) => {
      if (!res || Dirt.phase !== 'idle') return;
      if (res.garden) {
        if (res.garden.partial) { Dirt.resume(res.garden, DirtExt.opts({ debug: false })); DirtExt.watch(); }
        else { Dirt.restore(res.garden, DirtExt.opts({ debug: false })); }
        return;
      }
      if (res.spill) {
        const f = res.spill.fill;
        Dirt.start({ biome: res.spill.biome, flora: 'none', fill: [f, f], settled: true, shareButton: false, debug: false });
      }
    })
    .catch(() => {});
})();
