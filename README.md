# Dirt — Bury the Web

A creative digital work by Mark Sample. On any web page, the reader taps a button and shovelfuls
of dirt bury the lower third to half of the page; then a biome grows over it, chosen at random:
a flower garden, a meadow, vines up the edges like a trellis, a hedgerow, a forest on dark loam,
or cacti on sand. Revisit a buried page and the garden is still there. Mobile-first.

**Phase 1 (feasibility)** is complete: see **[FINDINGS.md](FINDINGS.md)** for what worked, measured on
an iPhone and across three desktop browsers. **Phase 2** is under way, extension-first: see
**[PHASE2.md](PHASE2.md)** for the feature list, decisions made, and decisions pending.

## Layout

| Path | What |
|---|---|
| `dirt-core.js` | The whole piece: one dependency-free module, `Dirt.start()` / `Dirt.stop()` / `Dirt.stats()`. Every spike injects this same file. |
| `spike-0-core/` | Heavy test page + Playwright benchmark harness. |
| `spike-a-ios-action-extension/` | Safari share-sheet Action extension, "Bury with Dirt" (top priority). |
| `spike-b-safari-web-extension/` | Manifest V3 Web Extension (Safari / Chrome / Firefox) — the Phase 2 foundation; saves and restores gardens. |
| `spike-c-in-app-browser/` | WKWebView browser + share extension for links from other apps. |
| `spike-d-web-fallback/` | Paste-a-URL website: iframe when allowed, else server-side screenshot. |
| `ios/` | XcodeGen spec that assembles the host app and the three extension targets from the spike folders. |
| `docs/` | Screenshots: one per biome, plus the Phase 1 fallback page. |
| `build.sh` | Regenerates the per-spike bundles (Spike A needs the core inlined into `Action.js`). |

## Quick start

```sh
npm install          # Playwright for the harnesses (pinned to the preinstalled Chromium)
npm run serve        # Spike 0 test page at http://localhost:8080/spike-0-core/test-page.html
npm run bench        # headless iPhone-emulated benchmark
npm run fallback     # Spike D at http://localhost:8787
sh build.sh          # after editing dirt-core.js
```

iOS: `brew install xcodegen && cd ios && xcodegen generate && open Dirt.xcodeproj` (see `ios/README.md`).

## Principles

- Dirt never reads or changes the host page; it only draws on top of it, in a Shadow DOM, on canvas.
- No data collection, no network requests, no storage, in the module and in the iOS routes.
- Nothing ties the project to a specific Apple Team ID; signing lives in an untracked `Config.xcconfig` value.
