// Runs in the page's isolated content-script world right after dirt-core.js, on every click.
//
//   click on a bare page            → bury it; when the garden finishes, save the scene
//   click while Dirt is on screen   → clear it
//   click on a page with a garden   → restore the saved garden
//
// Saved scenes come from the background script via globalThis.__dirtSaved (set just before this
// file runs). Nothing here reads or changes the host page.
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const saved = globalThis.__dirtSaved; globalThis.__dirtSaved = undefined;
  const siteAllowed = globalThis.__dirtSiteAllowed; globalThis.__dirtSiteAllowed = undefined;

  if (Dirt.phase !== 'idle') { Dirt.stop(); return; }

  const capture = () => api.runtime.sendMessage({ type: 'dirt:capture' }).then(u => u || null);

  if (saved) { Dirt.restore(saved, { debug: true, capture }); return; }

  Dirt.start({
    debug: true,
    capture,
    onPhase: (phase) => {
      if (phase !== 'garden') return;
      const data = Dirt.export();
      if (data) api.runtime.sendMessage({ type: 'dirt:save', url: location.href, data }).catch(() => {});
      if (!siteAllowed) console.info('[dirt] garden saved; it will come back on the next click (site access not granted, so not at page load)');
    }
  });
})();
