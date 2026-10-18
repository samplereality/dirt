# Spike 0 — core animation harness

`../dirt-core.js` running over `test-page.html`, a deliberately hostile host page: sticky header
with an infinite marquee, four CSS-animated ad slots, a hue-rotating image grid, 14 large
procedurally drawn images, global `div { position: relative; z-index: 1 }` rules, and a fixed bottom
bar at `z-index: 2147483000`.

```sh
npm install           # playwright, pinned to the preinstalled Chromium build
npm run serve         # http://localhost:8080/spike-0-core/test-page.html  — open on a phone on the same Wi-Fi
npm run bench         # headless iPhone-14 emulation, prints per-phase fps / frame time (--biome desert to force one)
npm run bench:phone   # same with 4x CPU throttling
node spike-0-core/bench.mjs --throttle 8 --baseline   # the host page alone, no overlay
```

## How the core works

- **Container**: one `<dirt-overlay>` element appended to `<html>`, `position:fixed; inset:0; z-index:2147483647; pointer-events:none`, all inline with `!important`, with an open Shadow DOM holding two canvases and the optional HUD.
- **Dirt**: a falling-sand cellular automaton on a grid of `cellSize` CSS px (4 px → 98×166 cells on an iPhone 14). A shoveller off the left or right edge slings big clumps (250–700 grains) across the page on ballistic arcs aimed at the lowest point of the surface; grains fall, slide, tumble and pile. Rendered through a `W×H` `ImageData` buffer scaled up with `image-rendering: pixelated`. Each run picks a fill line between a third and a half of the viewport height (`fill` option); the bury is complete when the mean surface reaches it and the last heap has slumped, air pockets below the surface are tamped, and the page above the soil line stays visible.
- **Biomes** (0.3.0): one per run, chosen at random (`biome` option forces one), each naming a dirt palette and a flora system:
  - *garden* — ground flowers and leaf pairs carpet the dirt in drifts, each blooming at its own pace (0.8–3.5 s) until about three quarters of the soil is covered.
  - *meadow* — grass blades as curved strokes growing at their own speed, with scattered wildflowers.
  - *trellis* — vines climb both window edges from the soil line to the top, with leaves, trumpet flowers and tendrils.
  - *hedgerow* — flowering bushes rise 15–25 % of the viewport above the soil line.
  - *forest* — dark loam; tall trunks (25–42 % of the viewport) that grow trunk → branches from the base up → leaves along each branch → a cluster at each tip. Two in five are evergreens: 11–15 tiers of down-swept branches with needles from low on the trunk, bottom tier first.
  - *desert* — sandy dirt; columnar cacti with arms and spines, barrel cacti, the odd flower on top.
  Growth is staggered: per-plant delays and rates, and for the carpets a few wandering cluster centres decide where the next sprout lands. Every biome except desert and meadow also grows low groundcover (tufts, clover) on the dirt itself (`COVER_DENSITY`).
- **Settled start**: `settled: true` builds the pile instantly from a gently bumpy profile at the fill line and skips the throw; with `flora: 'none'` that is the spill-over the extension puts on the pages after a buried one.
- **Checkpoint / resume**: `Dirt.checkpoint()` is a small mid-routine snapshot (biome, fill, phase, soil profile); `Dirt.resume(data)` rebuilds the pile so far and keeps throwing, or grows the garden on the settled dirt. The extension saves one every 2 s and on page hide.
- **Share** (0.3): a round button in the lower-right corner appears when the garden is complete (`shareButton` option). `Dirt.share()` hides the button and HUD for a frame, takes `opts.capture()` if the host provides one (the extension's tab capture) or composes a picture of the garden alone, then uses the Web Share API with files where available and downloads a PNG otherwise.
- **Export / restore**: `Dirt.export()` returns the biome, fill, per-column soil profile and every plant primitive (25–35 KB); `Dirt.restore(data)` rebuilds it in the current viewport as a finished garden. The test page's Save / Restore buttons exercise it via `sessionStorage`; the extension keeps real ones in `storage.local`.
- **Resize / rotation keeps the scene.** Every plant primitive (stem polyline, leaf, flower, tendril) is recorded in a display list as it is drawn; on a resize the pile is rebuilt from its old surface profile (same depth fraction per column), anchor positions are transformed, and the plants are replayed at their original sizes, so nothing goes oblong. A modest height-only change (Safari's address bar) translates instead of scaling, so the pile stays put. The viewport size is polled from the frame loop and a 400 ms timer as well as from `resize` events, because the share-sheet injection context never delivered the event.
- **Feel** (0.3): shovelfuls vary in size (0.6–1.4×) and arrive on an irregular rhythm. Each enters the frame around the middle of the page at the shoveller's edge and flies the flattest arc that clears the terrain (lobbed higher only until it does, never past the top of the screen; thrown from the other side if it still cannot), under one constant gravity, so it is slow going up and fast coming down. The clump holds together in the air; on impact three quarters of the grains skid along the surface away from the hit (never upward), the rest walk downhill as they are deposited until the heap stands no steeper than about one in two, the angle loose earth rests at. The sand automaton has the same slope in its rules: a diagonal slide that tumbles two or three cells at a time, a sideways slump when the ground two cells over is two lower, a rare one-cell step that rounds the humps, and a near-certain one above the fill line. A grain whose support slid away during the tick slides too instead of dropping like a piston, so a steep face crumbles within a few ticks rather than standing as a wall. Nothing settles more than 12 % of the height above the fill line. The simulation ticks at `simHz` (default 30) under a 60 fps render.
- **Instrumentation**: `Dirt.stats()` returns fps, mean and p95 frame time, sim/draw ms, long-frame count, coverage, fill (target, actual mean, tallest column), `spike` (the tallest cliff: rows a column stands above the lower of the surfaces three cells either side), and a frame counter (`Dirt.ping()`) used as a heartbeat by the extension spikes. `debug: true` shows these in a HUD.

## Measured (headless Chromium, iPhone 14 emulation, 390×664 CSS px @2x, 190 DOM nodes + animations)

| CPU throttle | Host page alone | Dirt: bury phase | Dirt: plant phase | Dirt sim+draw time |
|---|---|---|---|---|
| 1× | 60 fps, p95 16.8 ms | 59 fps, p95 33 ms | 60 fps, p95 16.8 ms | 0.3 ms / 0.3 ms |
| 4× | 60 fps, p95 16.8 ms | 57 fps (min 40), p95 33 ms | 52 fps (min 37), p95 33 ms | 1.6 ms / 1.3 ms |
| 8× | 52 fps, p95 33 ms | 32 fps (min 21), p95 100 ms | 32 fps (min 18), p95 83 ms | 3.9 ms / 2.9 ms |

(An earlier full-cover version of the growth phase, with up to 320 concurrent tips and a canopy over
the whole viewport, ran at 42 fps at 4× and 20 fps at 8×; the three-system garden is cheaper. A
coarser grid or a 1× growth canvas made no difference on that version, which is what points at
compositing rather than draw calls.)

Timeline (0.3.0, phone size): bury ≈ 18 s, then meadow ≈ 11 s, forest ≈ 19 s, garden / hedgerow / desert ≈ 23 s, trellis ≈ 33 s.

**On a real iPhone 16 Pro, iOS 27.0.1** (Mark, 2026-10-16, nytimes.com via the share-sheet extension): 57–60 fps, 16–17 ms per frame, p95 flat, through both phases.

Reading the numbers: the JavaScript cost of the simulation and drawing is small (≤ 4 ms even at
8× throttle). The frame-rate drop under throttling comes from the browser re-rasterising and
compositing a full-screen canvas in *software* (headless Chromium has no GPU).
A real iPhone composites canvases on the GPU, so the on-device number is the one that matters;
the success criterion (~60 fps on a recent iPhone over a heavy page) is **plausible but
unverified** until `test-page.html` is opened on a phone (`npm run serve`).

Screenshots: `../docs/spike0-burying.png` (t = 10 s) and the end state of each biome: `../docs/biome-garden.png`, `biome-meadow.png`, `biome-trellis.png`, `biome-hedgerow.png`, `biome-forest.png`, `biome-desert.png`.
