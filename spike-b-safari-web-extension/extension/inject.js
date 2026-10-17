// Runs in the page's isolated content-script world right after dirt-core.js and shared.js, on
// every click of the toolbar button.
//
//   click on a bare page            → bury it; when the garden finishes, save scene + thumbnail
//   click while Dirt is on screen   → clear it
//   click on a page with a garden   → restore the saved garden
//
// Saved scenes come from the background script via globalThis.__dirtSaved (set just before this
// file runs). Nothing here changes the host page; document.title is read once as the album label.
(function () {
  const saved = globalThis.__dirtSaved; globalThis.__dirtSaved = undefined;
  const siteAllowed = globalThis.__dirtSiteAllowed; globalThis.__dirtSiteAllowed = undefined;
  const opts = { debug: true, capture: DirtExt.capture, onAlbum: DirtExt.openAlbum };

  if (Dirt.phase !== 'idle') { Dirt.stop(); return; }
  if (saved) { Dirt.restore(saved, opts); return; }

  Dirt.start(Object.assign({}, opts, {
    onPhase: (phase) => {
      if (phase !== 'garden') return;
      DirtExt.saveCurrent().catch(() => {});
      if (!siteAllowed) console.info('[dirt] garden saved; it will come back on the next click (site access not granted, so not at page load)');
    }
  }));
})();
