# Dirt — Phase 2 plan

Phase 1 showed the piece works everywhere it needs to. Phase 2 turns the spikes into the thing:
an **extension-first** project, shipped as a browser extension on desktop (Chrome, Firefox, Safari)
and as an iOS app that bundles the Safari extension plus the share-sheet action, with the web
fallback as the no-install demo link. The in-app WKWebView browser (Spike C) is retired.

Everything still injects the one `dirt-core.js`. The core never reads or changes the host page,
sends nothing anywhere, and stores nothing itself; persistence is the extension's job.

## Features

| # | Feature | Where it lives | Status |
|---|---|---|---|
| 1 | Dirt never higher than half the page (now a third to a half) | core `fill` default | **done** (0.3.0) |
| 2 | Flora grows at varied rates, in drifts, not all at once | core: staged blooms, wandering clusters, per-plant rates and delays | **done** (0.3.0) |
| 3 | More biomes with their own dirt colour: garden, meadow, trellis, hedgerow, forest, desert | core: biome table + palettes + flora systems | **done** (0.3.0); more biomes are additive |
| 4 | Saved gardens: revisit a buried page and the garden is still there | core `Dirt.export()` / `Dirt.restore()`; extension `storage.local` keyed by URL | **done** (0.3.0), needs device/desktop test |
| 5 | Dirt that follows links, diminishing over the next few pages | background per-tab budget + injection on navigation | needs a permission decision (below) |
| 6 | Snapshot-and-share icon in a corner of the overlay | overlay corner control; `tabs.captureVisibleTab` in background; Web Share API / download | next |
| 7 | Album of buried sites with thumbnails | thumbnail at completion → IndexedDB in background; album page inside the extension | next, after 6 |

## Decisions already made

- **Save the scene, not the seed.** The simulation runs on real frame timing, so a seed would not
  reproduce the same pile. The core keeps a display list of every plant primitive and the soil
  profile per column; that is what is saved (25–35 KB per garden) and replayed instantly on revisit,
  into whatever viewport the reader has now.
- **Click semantics in the extension**: bare page → bury and save on completion; Dirt on screen →
  clear; page with a saved garden → restore. "Forget this garden" lives in the album (feature 7).
- **Storage**: `storage.local` for scenes (needs only the `storage` permission; ~10 MB default in
  Chrome, so 250+ gardens before `unlimitedStorage` is needed). Thumbnails go to IndexedDB in the
  background script, never to the page's own storage. No `storage.sync`.
- **Share-sheet action (iOS)** stays as the quick entry but cannot save or restore: its script
  lives in the page and has no extension storage. The Web Extension is the foundation.

## Decisions for Mark

- **Feature 5 permissions.** Injecting on the *next* page without a click needs host permission
  for that site. Options: (a) request `<all_urls>` up front — simplest, but store reviewers and
  the privacy note both suffer; (b) ask for an optional host permission the first time the reader
  turns "dirt follows links" on — one extra prompt, honest, recommended; (c) skip the feature.
  Safari on iOS asks per site regardless.
- **What the album keeps.** A thumbnail per garden means the extension keeps a list of pages the
  reader buried, with a small picture of each. It never leaves the device, but it belongs in the
  privacy note. Per-URL or per-site keys is also a product choice (per-URL for now).
- **Biome balance.** Random with equal odds today. Weighting (e.g. desert rarer) is one line.

## Order of work

1. ~~Core: fill cap, varied growth, biomes, export/restore.~~ Done.
2. ~~Extension: save on completion, restore on click.~~ Done; verify on desktop and iPhone.
3. Snapshot and share (6): corner control in the overlay (the only interactive part; the rest stays
   click-through), background capture, share sheet on mobile, download on desktop. Verify Safari
   iOS honours `captureVisibleTab` from a web extension — if not, the fallback is sharing the
   garden canvas alone (no page) which the core can produce itself.
4. Album (7): thumbnails + extension page, with "forget" and "regrow".
5. Dirt follows links (5), once the permission decision is made.
6. Distribution: Chrome Web Store and Firefox Add-ons listings; the iOS app on TestFlight via the
   colleague's account (`ios/Config.xcconfig` carries no Team ID, so the move is a one-line edit).

## Still open from Phase 1

- End state: the garden stays until the reader clicks again. Fade, loop, or re-emerge are each a
  few lines once chosen.
- Reduced motion: `prefers-reduced-motion` is ignored; the honest option is a faster, quieter bury.
- Rotation replays the scene proportionally, so canopies widen in landscape. Replaying with a
  uniform scale anchored at the soil line would keep shapes true at the cost of blank margins.
