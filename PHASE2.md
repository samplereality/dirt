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
| 4 | Saved gardens: revisit a buried page and the garden is already there, no click | core `Dirt.export()` / `Dirt.restore()`; extension `storage.local` keyed by URL; `autorestore.js` content script on allowed sites | **done** (ext 0.4), verified headless; needs a real-browser check of the per-site prompt |
| 5 | Dirt that follows links, diminishing over the next few pages | per-tab budget in the background from the first shovelful, answered through the page-load lookup or injected by the background on navigation; core `flora: 'none'` for dirt-only; album switch for other sites | **done** (ext 0.6): 45 % / 22 % / 10 % of the original fill on the next three pages, there before the garden is finished |
| 6 | Snapshot-and-share icon in a corner of the overlay | core: share button + `Dirt.share()`; extension: `tabs.captureVisibleTab`; Web Share API with download fallback | **done** (core 0.3, ext 0.4); see capture note below |
| 7 | Album of buried sites with thumbnails | thumbnail + title saved with the scene in `storage.local`; `album.html` inside the extension (also its options page); grid-icon button in the overlay opens it | **done** (ext 0.5) |

## Decisions already made

- **Save the scene, not the seed.** The simulation runs on real frame timing, so a seed would not
  reproduce the same pile. The core keeps a display list of every plant primitive and the soil
  profile per column; that is what is saved (25–35 KB per garden) and replayed instantly on revisit,
  into whatever viewport the reader has now.
- **Click semantics in the extension**: bare page → bury and save on completion; Dirt on screen →
  clear; page with a saved garden → restore. "Forget this garden" lives in the album (feature 7).
- **Site access is asked per site, on the first bury, never at install.** The click that buries
  a page also asks, through the browser's own prompt, to run on that site in future; that is what
  lets a garden come back at page load. Declined → the garden still returns on the next click.
  No `<all_urls>` at install, so no scary store warning and the privacy note stays simple.
- **Storage**: everything in `storage.local` with `unlimitedStorage` (no prompt in any browser):
  `garden:<url>` the scene (8–35 KB), `thumb:<url>` a 320-px JPEG (30–50 KB), `album:index` the
  list the album renders from. Never the page's own storage. No `storage.sync`.
- **What the album records.** Per garden: the URL, the page title (read once by the extension's
  content script as the label; the core itself still never reads the page), hostname, biome,
  fill, date, and a thumbnail. The thumbnail is the tab capture when the tab is still in front
  when the garden completes, otherwise the garden alone. All of it stays on the device; the
  privacy note should say the extension keeps a list of buried pages with small pictures of them.
- **Forget**: per card in the album, or everything at once. Forgetting a page means the next
  click on it buries it afresh.
- **Share-sheet action (iOS)** stays as the quick entry but cannot save or restore: its script
  lives in the page and has no extension storage. The Web Extension is the foundation.
- **What the shared picture contains.** After a click on the extension button, the picture is the
  whole visible tab, page and garden together (`activeTab` allows `captureVisibleTab`). After a
  silent page-load restore there has been no click, and Chrome refuses the capture unless the
  extension holds all-sites permission, so the core falls back to a picture of the garden alone on
  a plain background, which it composes itself with no permission at all. The share-sheet action
  and the web fallback always get the garden-alone picture. Verified in headless Chromium: the
  error is exactly "Either the '<all_urls>' or 'activeTab' permission is required", and a per-site
  grant does not satisfy it.
- **Per-browser builds.** Chrome and Firefox disagree on the manifest keys for optional site
  access (`optional_host_permissions` vs. optional `host_permissions`) and for the background
  script. `sh build.sh` writes warning-free `dist/chrome/` and `dist/firefox/`; `extension/` stays
  the source and the Safari target.

## Decisions for Mark

- **Feature 5 reach (decided as recommended).** Spill-over reaches any site the reader has
  allowed, which covers links within the buried page's own site for free. The album has a switch,
  "let dirt follow links to other sites", that asks once for the browser's all-sites permission;
  off by default. Semantics: the next three pages opened in that tab get 45 %, 22 % and 10 % of
  the original fill, same dirt colour, no garden, no buttons, and **already settled when the page
  opens**, as if it landed at the same time as the dirt on the first page (core `settled: true`);
  a link opened into a new tab inherits the budget from its opener; going back to a page that
  already got its spill shows the same amount; returning to the buried page itself (the garden
  restores) refreshes the budget. The budget starts with the first shovelful (`dirt:begin`, and
  every checkpoint), not when the garden finishes, so leaving mid-bury still carries dirt; and on
  pages the content script does not reach, the background injects the same scripts itself when
  a tab that owes spill-over finishes loading (ext 0.6).
- **What the album keeps.** A thumbnail per garden means the extension keeps a list of pages the
  reader buried, with a small picture of each. It never leaves the device, but it belongs in the
  privacy note. Per-URL or per-site keys is also a product choice (per-URL for now).
- **Biome balance.** Random with equal odds today. Weighting (e.g. desert rarer) is one line.

## Order of work

1. ~~Core: fill cap, varied growth, biomes, export/restore.~~ Done.
2. ~~Extension: save on completion, restore at page load (per-site permission) or on click.~~ Done; verify the prompt on desktop and iPhone.
3. ~~Snapshot and share (6).~~ Done: a round share button appears in the lower-right corner when
   the garden completes (the only interactive part of the overlay; the rest stays click-through),
   hides itself and the HUD for the capture, then hands a PNG to the share sheet where the Web
   Share API supports files (iPhone, Android, desktop Safari and Edge) or downloads it. Verify on
   the iPhone that Safari honours `captureVisibleTab` and that the share sheet opens.
4. ~~Album (7).~~ Done: `album.html` lists every saved garden newest first with thumbnail, title,
   host, biome and date; Visit opens the page (the garden restores itself on allowed sites);
   Forget per card or for all. Reached from the grid-icon button beside the share button, or from
   the extension's settings (it is the options page). Verified in headless Chromium: two burials
   → two cards with thumbnails → forget one → storage cleaned.
5. ~~Dirt follows links (5).~~ Done; verified in headless Chromium across same-tab navigations,
   the back button, a new tab opened from the buried page, leaving mid-bury, and with the content
   script disabled (background injection path).
6. Distribution: Chrome Web Store and Firefox Add-ons listings; the iOS app on TestFlight via the
   colleague's account (`ios/Config.xcconfig` carries no Team ID, so the move is a one-line edit).

## Feel of the throw (after device feedback)

The shoveller stands off the left or right edge. Each shovelful (250–700 grains, a dozen or so
per phone screen) enters the frame around the middle of the page, always above the dirt at that
edge, and flies to the lowest point of the pile on a ballistic arc: the flattest one that clears
the terrain, lobbed higher only until it does and never past the top of the screen (thrown from
the other side if it still cannot). One constant gravity, so the clump is slow on the way up and
fast on the way down. It holds together in the air; on impact three quarters of the grains skid
along the surface away from the hit, falling where the ground drops and stopping where it rises,
so spread is always sideways or down, never up; the rest walk downhill as they are deposited
until the heap stands no steeper than about one in two. The sand rules share that slope (see the
spike-0 README), and a grain whose support slid away during the tick slides too instead of
dropping straight into the hole, which is what used to leave steep faces standing as walls for
seconds. Grains that roll off the page edge are gone. As a last resort nothing settles more than
12 % of the height above the fill line: a grain that would slips to a random nearby column with
room. The bury ends only once the last heap has slumped (`spike` ≤ 4 rows, or 3 s after the last
throw). Measured in the harness: the tallest column never exceeds the fill line by more than
that 12 %, on phone or desktop, the mean fill lands within 1–2 % of target, and after the last
throw no column stands more than 8 rows above its neighbours three cells away; mid-impact a
clump reads as a lump for a few ticks before it spreads.

Tuning knobs, all in `dirt-core.js`: clump size (`shovelCells`), flight time (22 + distance·18
ticks, raised ×1.18 per try), gravity `g = 0.05`, splash share (0.75) and skid speed (±3.6
cells), the slide thresholds in `steepSide()` and `settle()`, the calm test in `stepBury()`.

## Leaving mid-routine

`Dirt.checkpoint()` is a small snapshot (biome, fill, phase, soil profile; no plants). The
extension saves one every 2 s and on page hide. Coming back, `Dirt.resume()` rebuilds the pile
so far and either keeps throwing to the target (if it was mid-bury) or grows the garden on the
settled dirt (if it was mid-growth; partial plants are not kept, the garden regrows). A finished
garden still saves normally at the end. Verified: leave at 13 % fill, return, continue from 13 %.

## Forest and groundcover

Trees grow trunk → branches in turn from the base up → leaves along each branch as it extends →
a cluster spreading from each branch tip. Two in five are evergreens: 11–15 tiers of down-swept
branches with needles from low on the trunk, bottom tier first, extending about twice as fast
as deciduous branches so the tree fills in while the others are still bare poles. Every biome except desert and meadow also gets
groundcover on the dirt itself, low tufts and clover filling in during growth (density per
biome in `COVER_DENSITY`).

## Still open from Phase 1

- End state: the garden stays until the reader clicks again. Fade, loop, or re-emerge are each a
  few lines once chosen.
- Reduced motion: `prefers-reduced-motion` is ignored; the honest option is a faster, quieter bury.
- Rotation replays the scene proportionally, so canopies widen in landscape. Replaying with a
  uniform scale anchored at the soil line would keep shapes true at the cost of blank margins.
