// Content script, runs at page load on sites the reader has allowed (see background.js).
// One message to the background: is there a saved garden for this URL? If so, restore it,
// silently (no HUD). Nothing here reads or changes the host page; if there is no garden, nothing
// is drawn and dirt-core.js stays inert.
(function () {
  if (typeof Dirt === 'undefined' || typeof DirtExt === 'undefined') return;
  if (window !== window.top) return;
  DirtExt.api.runtime.sendMessage({ type: 'dirt:lookup', url: location.href })
    .then((data) => { if (data && Dirt.phase === 'idle') Dirt.restore(data, { debug: false, capture: DirtExt.capture, onAlbum: DirtExt.openAlbum }); })
    .catch(() => {});
})();
