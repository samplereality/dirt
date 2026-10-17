// Runs in the page's isolated content-script world right after dirt-core.js and shared.js, on
// every click of the toolbar button.
//
//   click on a bare page              → bury it; checkpoints while it runs; saves scene + thumbnail at the end
//   click while Dirt is on screen     → clear it
//   click on a page with a garden     → restore it (or continue it, if it was left mid-routine)
//
// Saved scenes come from the background script via globalThis.__dirtSaved (set just before this
// file runs). Nothing here changes the host page; document.title is read once as the album label.
(function () {
  const saved = globalThis.__dirtSaved; globalThis.__dirtSaved = undefined;
  const siteAllowed = globalThis.__dirtSiteAllowed; globalThis.__dirtSiteAllowed = undefined;

  if (Dirt.phase !== 'idle') { Dirt.stop(); return; }

  if (saved) {
    if (saved.partial) { Dirt.resume(saved, DirtExt.opts({ debug: true })); DirtExt.watch(); }
    else { Dirt.restore(saved, DirtExt.opts({ debug: true })); }
    return;
  }

  Dirt.start(DirtExt.opts({ debug: true }));
  DirtExt.watch();
  if (!siteAllowed) console.info('[dirt] site access not granted: the garden will come back on the next click, not at page load');
})();
