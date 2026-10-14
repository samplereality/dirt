# Dirt — Bury the Web

A creative digital work by Mark Sample. On any web page, the reader taps a button and shovelfuls
of dirt bury the lower half to two-thirds of the page; then, at random, flowers carpet the soil, vines
climb the edges of the window like a trellis, or flowering bushes rise from the dirt into the page above.
Mobile-first. This repository is **Phase 1: feasibility** — throwaway spikes answering one
question: which delivery mechanisms can put an animated overlay on top of arbitrary web pages on
a phone, smoothly and reliably?

Read **[FINDINGS.md](FINDINGS.md)** for what worked, what is unverified, and the recommended mix for Phase 2.

## Layout

| Path | What |
|---|---|
| `dirt-core.js` | The whole piece: one dependency-free module, `Dirt.start()` / `Dirt.stop()` / `Dirt.stats()`. Every spike injects this same file. |
| `spike-0-core/` | Heavy test page + Playwright benchmark harness. |
| `spike-a-ios-action-extension/` | Safari share-sheet Action extension, "Bury with Dirt" (top priority). |
| `spike-b-safari-web-extension/` | Manifest V3 Web Extension (Safari / Chrome / Firefox). |
| `spike-c-in-app-browser/` | WKWebView browser + share extension for links from other apps. |
| `spike-d-web-fallback/` | Paste-a-URL website: iframe when allowed, else server-side screenshot. |
| `ios/` | XcodeGen spec that assembles the host app and the three extension targets from the spike folders. |
| `docs/` | Screenshots referenced by the findings. |
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
