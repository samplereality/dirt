# Spike 0 — core animation harness

`../dirt-core.js` running over `test-page.html`, a deliberately hostile host page: sticky header
with an infinite marquee, four CSS-animated ad slots, a hue-rotating image grid, 14 large
procedurally drawn images, global `div { position: relative; z-index: 1 }` rules, and a fixed bottom
bar at `z-index: 2147483000`.

```sh
npm install           # playwright, pinned to the preinstalled Chromium build
npm run serve         # http://localhost:8080/spike-0-core/test-page.html  — open on a phone on the same Wi-Fi
npm run bench         # headless iPhone-14 emulation, prints per-phase fps / frame time
npm run bench:phone   # same with 4x CPU throttling
node spike-0-core/bench.mjs --throttle 8 --baseline   # the host page alone, no overlay
```

## How the core works

- **Container**: one `<dirt-overlay>` element appended to `<html>`, `position:fixed; inset:0; z-index:2147483647; pointer-events:none`, all inline with `!important`, with an open Shadow DOM holding two canvases and the optional HUD.
- **Dirt**: a falling-sand cellular automaton on a grid of `cellSize` CSS px (4 px → 98×166 cells on an iPhone 14). Shovelfuls are ~50-cell clumps thrown in from above the viewport, aimed at the lowest point of the surface; grains fall, slide diagonally and pile. Rendered through a `W×H` `ImageData` buffer scaled up with `image-rendering: pixelated`. Each run picks a fill line between 50 % and 66 % of the viewport height (`fill` option); the bury is complete when every column reaches it, air pockets below the surface are tamped, and the page above the soil line stays visible.
- **Flora**: one of three kinds per run, chosen at random (`flora` option forces one), drawn on a device-resolution persistent canvas:
  - *Ground flowers* sprinkle five-petal flowers and leaf pairs across the dirt until about three quarters of the soil cells are covered, so the dirt still shows through.
  - *Vines* (three to five per side) climb the left and right edges from the soil line to the top of the window along a sine path, with alternating heart-ish leaves, trumpet flowers, and curling tendrils reaching inward, as if on a trellis.
  - *Bushes* rise from the soil line at regular intervals across the width, each to a height of 15–25 % of the viewport (`bushHeight` option): branching tips (max depth 4) with leaves along the way and a bloom in the bush's own colour at the end of every branch.
  The growth phase ends when that kind is finished (flowers at target density, vines at the top, bushes done branching); the loop then stops and the garden stays on screen.
- **Resize**: a height-only change (address bar) keeps everything bottom-anchored, unscaled; a width change (rotation, window resize) replants the same run from scratch. The dirt layer is redrawn after any resize.
- **Instrumentation**: `Dirt.stats()` returns fps, mean and p95 frame time, sim/draw ms, long-frame count, coverage, and a frame counter (`Dirt.ping()`) used as a heartbeat by the extension spikes. `debug: true` shows these in a HUD.

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

Timeline at every setting: bury ≈ 16 s, then flowers ≈ 13 s, bushes ≈ 17 s or vines ≈ 27 s.

**On a real iPhone** (Mark, 2026-10-16, nytimes.com via the share-sheet extension): 57–60 fps, 16–17 ms per frame, p95 flat, through both phases.

Reading the numbers: the JavaScript cost of the simulation and drawing is small (≤ 4 ms even at
8× throttle). The frame-rate drop under throttling comes from the browser re-rasterising and
compositing a full-screen canvas in *software* (headless Chromium has no GPU).
A real iPhone composites canvases on the GPU, so the on-device number is the one that matters;
the success criterion (~60 fps on a recent iPhone over a heavy page) is **plausible but
unverified** until `test-page.html` is opened on a phone (`npm run serve`).

Screenshots: `../docs/spike0-burying.png` (t = 10 s) and the end state of each kind: `../docs/spike0-flowers.png`, `../docs/spike0-vines.png`, `../docs/spike0-bushes.png`.
