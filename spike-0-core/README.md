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
- **Dirt**: a falling-sand cellular automaton on a grid of `cellSize` CSS px (4 px → 98×166 cells on an iPhone 14). Shovelfuls are ~60-cell clumps thrown in from above the viewport, aimed at the lowest point of the surface; grains fall, slide diagonally and pile. Rendered through a `W×H` `ImageData` buffer scaled up with `image-rendering: pixelated`. The bury is complete when every column reaches the top row; trapped air pockets are then tamped.
- **Growth**: shoot tips (position, heading, remaining length, width, depth) advance each frame on a device-resolution persistent canvas, wobble, lean upward, branch (max depth 4), drop leaves and the occasional flower. A green-coverage grid tracks what the canopy has covered; seeds sprout in bare patches until coverage ≥ 97.5 %, then the remaining bare cells are leafed over and the loop stops.
- **Instrumentation**: `Dirt.stats()` returns fps, mean and p95 frame time, sim/draw ms, long-frame count, coverage, and a frame counter (`Dirt.ping()`) used as a heartbeat by the extension spikes. `debug: true` shows these in a HUD.

## Measured (headless Chromium, iPhone 14 emulation, 390×664 CSS px @2x, 190 DOM nodes + animations)

| CPU throttle | Host page alone | Dirt: bury phase | Dirt: growth phase | Dirt sim+draw time |
|---|---|---|---|---|
| 1× | 60 fps, p95 16.8 ms | 60 fps, p95 16.8 ms | 60 fps, p95 16.8 ms | 0.5 ms / 0.4 ms |
| 4× | 60 fps, p95 16.8 ms | 56 fps, p95 33 ms | 42 fps, p95 33 ms | 2.0 ms / 2.2 ms |
| 8× | 52 fps, p95 33 ms | 29 fps, p95 67 ms | 20 fps, p95 83 ms | 4.1 ms / 4.9 ms |
| 8×, cellSize 6 | — | 30 fps | 20 fps | 2.4 ms / 5.3 ms |
| 8×, maxDpr 1 | — | 30 fps | 21 fps | 5.2 ms / 6.5 ms |

Timeline at every setting: bury ≈ 16 s, growth ≈ 15 s, loop idles at ≈ 41 s.

Reading the numbers: the JavaScript cost of the simulation and drawing is small (≤ 7 ms even at
8× throttle). The frame-rate drop under throttling comes from the browser re-rasterising and
compositing a full-screen canvas in *software* (headless Chromium has no GPU). Neither a coarser
grid nor a 1× growth canvas changes that, which points at compositing rather than our draw calls.
A real iPhone composites canvases on the GPU, so the on-device number is the one that matters;
the success criterion (~60 fps on a recent iPhone over a heavy page) is **plausible but
unverified** until `test-page.html` is opened on a phone (`npm run serve`).

Screenshots: `../docs/spike0-burying.png` (t = 10 s), `../docs/spike0-garden.png` (end state).
