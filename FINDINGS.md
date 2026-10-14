# Dirt — Phase 1 findings

Date: 2026-10-14. Author of the spikes: Claude, working from Mark Sample's project brief.

## Summary

- **The core is sound.** `dirt-core.js` (≈ 600 lines, no dependencies) buries the bottom 50–66 %
  of a hostile test page and grows a garden over it in about 43 s, at 60 fps in headless Chromium with iPhone emulation,
  with sim + draw costing under 1 ms per frame unthrottled and under 4 ms at 8× CPU throttling.
  It sits above sticky headers and a fixed bar at `z-index: 2147483000`, survives hostile global
  CSS, and handles viewport resizes. Screenshots in `docs/`.
- **Every delivery mechanism is scaffolded and injects the same file unchanged.** Spikes A, B and C
  are complete Xcode targets described by one XcodeGen spec; Spike D is a working server + page.
- **What this phase could not verify** (no iOS toolchain, no real device, and no outbound internet
  in the build container): on-device frame rate, whether an animation started from an Action
  extension's `finalize()` survives the extension's dismissal, Safari's extension-enabling friction,
  and the live 22-site framing/screenshot survey. Each has a ready-to-run checklist below; the
  device tests are an afternoon with an iPhone and Xcode.

## Spike 0 — core animation harness: **works**

Measured in headless Chromium (Playwright `iPhone 14` descriptor, 390 × 664 CSS px at 2×, 98 × 166
cell grid) over `spike-0-core/test-page.html`, which has 190 DOM nodes, five continuously
animating regions, 14 large images, a sticky header and a fixed bottom bar.

| CPU throttle | Host page alone | Dirt: bury | Dirt: plants | Dirt's own JS (sim / draw) |
|---|---|---|---|---|
| 1× | 60 fps | 59 fps, p95 33 ms | 60 fps, p95 16.8 ms | 0.3 / 0.3 ms |
| 4× | 60 fps | 57 fps, p95 33 ms | 52 fps, p95 33 ms | 1.6 / 1.3 ms |
| 8× | 52 fps | 32 fps, p95 100 ms | 32 fps, p95 83 ms | 3.9 / 2.9 ms |

On the earlier full-cover version, coarser cells (6 px) or a 1× growth canvas did not change the
throttled numbers, so the throttled drop is the headless renderer's *software* compositing of a
full-screen canvas, not Dirt's code (which stays under 4 ms per frame even at 8×).
Phones composite on the GPU. The brief's criterion (≈ 60 fps on a recent iPhone over a heavy page)
is therefore plausible, and the unthrottled profile supports it, but it is **not yet measured on a
device**. To measure: `npm run serve`, open the test page on the phone, tap Bury, read the HUD.

Design decisions that held up:

- Falling-sand automaton on a low-resolution grid for the dirt: cheap, piles naturally, and
  "shovelfuls" fall out of it for free. Each run picks a fill line between 50 % and 66 % of the
  viewport; completion is "every column reaches the fill line", with trapped air pockets below the
  surface tamped afterwards. (Measuring coverage alone stalled at ~97 % in the first version.)
  The page above the soil line stays readable, which is the point.
- Three plant systems on a persistent device-resolution canvas: ground flowers that carpet the
  dirt to about three-quarters density, vines that climb both edges of the window like a trellis,
  and flowering bushes that rise from the soil line to fill roughly the next quarter of the
  window. See `docs/spike0-growing.png` and `docs/spike0-garden.png`. Bushes currently read as
  narrow columns; shape and species variety are Phase 2 art direction.
- Two stacked canvases (dirt at grid resolution, growth at device resolution) so the browser
  composites and the dirt layer stops redrawing once buried.
- Inline `!important` styles on a custom element plus Shadow DOM: the test page's
  `div { position: relative; z-index: 1 }` and `* { opacity: .999 }` rules had no effect.

Open issues: the HUD covers the top-left corner (debug only); the piece has no end-state behaviour
yet (loop idles with the garden on screen); `prefers-reduced-motion` is ignored; the overlay is
`pointer-events: none` so the reader can still scroll the buried page, which may or may not be wanted.

## Spike A — iOS Action extension: **scaffolded, device test pending (top priority)**

What is built: a no-UI Action extension (`com.apple.ui-services`, web-page activation rule,
`NSExtensionJavaScriptPreprocessingFile = Action`). `Action.js` is `dirt-core.js` plus an
`ExtensionPreprocessingJS` wrapper whose `finalize()` calls `Dirt.start({ debug: true })`. The
native handler returns immediately, so the share sheet closes at once.

The key question — does a `requestAnimationFrame` loop started in `finalize()` keep running after
the extension is dismissed? — **can only be answered on a device**. Reasoning from how Safari
implements it: the preprocessing file is injected into the page's JavaScript context and its
closures live in the page, so the loop should persist like any page script. Two risks are
designed for:

1. Safari tears down the injected context: switch `DIRT_INJECT_MODE` to `'script-tag'`, which
   copies the module source into the page's own world through an inline `<script>`. Sites with a
   strict `Content-Security-Policy` (`script-src` without `'unsafe-inline'`, i.e. most big news
   sites) would block that path, so the result must be recorded per site.
2. The heartbeat counter in the HUD makes survival visible without a debugger.

Test plan and recording sheet: `spike-a-ios-action-extension/README.md`.

Friction to expect: the action must be enabled once via *Edit Actions…*; it only appears for
Safari web pages (and `SFSafariViewController`), not for WKWebViews in other apps.

## Spike B — Safari Web Extension: **scaffolded, cross-browser by construction**

A plain MV3 extension (`action` + `activeTab` + `scripting.executeScript`), with both
`background.service_worker` and `background.scripts` so Safari, Chrome and Firefox each pick
the key they support. The Safari shell is a trivial `NSExtensionRequestHandling` class. The
extension files are copied flat into the `.appex`, so `manifest.json` sits at the resource root.

Verified: manifest and scripts are valid and minimal. Not verified: Safari's `activeTab`
behaviour on iOS (it may still prompt per site the first time) and the enabling path
(Settings → Apps → Safari → Extensions, then the puzzle-piece menu in the address bar). That is
two or three more taps than the share sheet and lives in a menu many readers never open, which
is why Spike A stays primary. Desktop Chrome and Firefox can load `extension/` unpacked in a
minute; do that first — it tests the injected module in an isolated world with no Xcode at all.

## Spike C — in-app browser: **scaffolded**

`WKWebView` with the module as a `WKUserScript` (document end, main frame only), a floating Bury
button that calls `Dirt.toggle()` via `evaluateJavaScript`, and a `ping` that reads the heartbeat
from native code. Links arrive by paste, by `dirt://open?url=…`, or from the `ShareToDirt`
extension, which parks the URL in an App Group and tries the well-known responder-chain
`openURL:` trick to foreground the app. That trick is unofficial and changes between iOS
releases; the App Group handoff is the reliable fallback (reader taps the app icon).

Costs to weigh: the web view has its own cookie jar (paywalls and logins show their walls), no
content blockers, and Apple's guideline 4.2 looks hard at apps that are "just a web view". This
route is a transport for links from other apps, not the headline experience.

## Spike D — web fallback: **server and page work; live survey pending**

`server.mjs` probes headers (`X-Frame-Options`, CSP `frame-ancestors`) following redirects with a
mobile UA, and takes a full-page screenshot with an iPhone-14 Chromium profile (scrolls first so
lazy images load; capped at 12 000 px; 1-hour cache). `public/index.html` frames the page when
allowed and otherwise shows the screenshot in a scroll container, with Dirt fixed above either.

Offline self-test (`RESULTS.LOCAL.md`): the verdicts for open / `DENY` / `SAMEORIGIN` /
`frame-ancestors 'none'` pages are correct; screenshots of a 12 000 px heavy page take ≈ 9 s, of
a plain page ≈ 2–3 s. The live run over the 22 sites in `sites.json` **did not happen** because
the build container has no outbound web access; `npm run probe` produces `RESULTS.md` in about
two minutes from any connected machine. Expectation from those sites' published headers: nearly
every large site forbids framing, so the screenshot path is the realistic default and the iframe
path is a bonus for small sites.

Privacy and security: this is the one route where a URL leaves the reader's device. The server
logs nothing and keeps cached PNGs for an hour; a public deployment needs the private-address
block kept on, rate limiting, and a privacy note on the page.

## Recommended delivery mix for Phase 2

1. **Spike A (share-sheet Action) as the primary iOS experience**, *conditional on the device test*.
   One tap from Safari's Share menu is the lowest-friction path that reaches the live page.
   Run the heartbeat test on nytimes.com, theguardian.com and a few CSP-strict sites before
   investing further; if `finalize()` does not survive dismissal and the script-tag fallback is
   CSP-blocked on the big sites, promote Spike B.
2. **Spike B (Web Extension) bundled in the same app** as the fallback that also gives desktop
   Chrome/Firefox/Safari for free. The same `extension/` folder can ship to the Chrome Web Store
   and AMO without an app at all, which widens the audience beyond iOS at little cost.
3. **Spike D (web fallback) as the no-install route** — screenshot-first, iframe when allowed —
   hosted with a clear privacy note. It is also the easiest thing to link from an artist's
   statement or an exhibition QR code.
4. **Spike C only if link-from-other-apps turns out to matter in practice.** It adds a WKWebView
   surface, App Group entitlement and review risk for a case the share sheet already covers once
   the reader opens the link in Safari.

## Notes for the App Store (guideline 4.2) and distribution

- The host app currently has two tabs: the in-app browser and a checklist. For review it needs a
  reason to exist beyond the extensions: the brief's ideas (saved gardens, before/after images,
  variations) are the natural candidates. Things the spikes already produce that could become
  features without much work: the end-state canvas is a saveable image (`canvas.toBlob`), the
  growth parameters (`cellSize`, `buryMs`, `growMs`, palettes) are already options, and the
  HUD's numbers could become a playful "soil report".
- Nothing in the project references a Team ID; `ios/Config.xcconfig` holds `DEVELOPMENT_TEAM`
  and the bundle-ID prefix so the project regenerates cleanly under the colleague's account.
  The App Group for Spike C is the one entitlement that will need re-registering after a transfer.
- TestFlight needs no additional work beyond signing.

## Open questions surfaced (for Mark, not decided here)

- Viewport vs full page: the module buries the bottom half-to-two-thirds of the *visible
  viewport*; the page still scrolls beneath it. Burying the full page would mean either following
  scroll (cheap) or an absolute-positioned page-sized overlay (expensive on long pages).
- End state: the loop currently idles with the garden on screen; persistence, looping, fading, or
  letting the page re-emerge are all a few lines in `stepFinal`.
- Style: the dirt is pixel-art by construction (grid cells); the plants are vector. Mixing reads
  fine at phone size but is a decision to make deliberately. The vines and bushes are the two
  places where a stronger illustration style would pay off most.
- Interaction: with `pointer-events: none` the reader can keep scrolling the buried page; a
  tap-to-clear or tap-to-plant would need the overlay to take pointer events.
- Sound: nothing prevents it technically in any route except the Action extension's injected
  context, where autoplay rules apply as to any page script (user gesture already happened).
