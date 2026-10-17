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
- **Device results (Mark, iPhone 16 Pro, iOS 27.0.1, 2026-10-16).** All three iOS routes built, installed under a
  free Personal Team, and ran without errors. **Spike A's key question is answered: yes** — the
  animation started from the Action extension's `finalize()` ran its full ~35 s life after the
  share sheet closed (heartbeat reached 2130 frames, i.e. bury plus bushes). On nytimes.com the
  HUD read 57–60 fps, 16–17 ms per frame, p95 flat; the success criterion is met. Rotation
  exposed two bugs (settled dirt vanished; dirt and flowers stretched oblong), both fixed since.
- **Spike D live survey (Mark, 2026-10-17, headless Google Chrome on a Mac):** 4 of 22 sites can
  be framed; 14 of 22 screenshots are usable; the other 8 are bot blocks (NYTimes 403, WSJ 401),
  login walls (Instagram, X), or app shells that render nothing without interaction (YouTube,
  Google Maps, Medium, Craigslist). Captures take 2–33 s. Screenshot-first is the right design,
  but the biggest news sites reject headless browsers outright.
- **Spike B verified on all three browsers:** Chrome and Firefox (temporary add-on) on the
  desktop, Safari on the iPhone, from the same `extension/` folder. Firefox showed the dirt
  piling into spiky towers, which turned out to be a wide-window problem in the sand rules, not
  a Firefox one; fixed (shovelfuls now stay phone-sized and arrive more often on wide windows). A note that the phone "could not rotate" while the
  extension ran turned out to affect every app, so it is the phone (orientation lock or a
  reboot), not Dirt; re-check after the resize fixes.

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
Phones composite on the GPU, and the device run bears that out: **on an iPhone over nytimes.com
the HUD showed 57–60 fps and 16–17 ms per frame with a flat p95** through both the dirt and the
plant phases. The brief's criterion is met.

Resize behaviour, after two rounds on the device: the first fix (replant on rotation) was judged
wrong on the phone — "everything starts from scratch" — so the core now keeps the scene. Every
plant primitive is recorded in a display list and replayed into the new shape at its original
size; the pile is rebuilt from its old surface profile; a modest height-only change (the address
bar) translates rather than scales. Spike A kept skewing after the first fix because the
share-sheet injection context never delivers `resize` events, so the viewport size is now polled
from the frame loop and a timer as well. (Resizing a canvas clears it, which is why a settled
pile vanished in the first round; the dirt layer is redrawn after any resize.)

Feel, after the device test ("falls too fast or too uniformly", "peaks too angular"): shovelfuls
now vary in size and rhythm, clumps have individual gravity with a terminal velocity, the sand
simulation ticks at 30 Hz under a 60 fps render (`simHz` option), and a shallower slide rule in
the automaton rounds the mounds. On a desktop-sized window (Firefox, 360 columns) the first
version of that still piled into towers, because a shovelful scaled with the window and landed
230 grains in one spot; shovelfuls are now capped at 80 grains and thrown more often instead,
each clump spreads wider, and the peak-eroding rule fires twice as often. Checked at 1440×900
and at phone size in the harness; whether the phone agrees is the next thing to look at.

Design decisions that held up:

- Falling-sand automaton on a low-resolution grid for the dirt: cheap, piles naturally, and
  "shovelfuls" fall out of it for free. Each run picks a fill line between 50 % and 66 % of the
  viewport; completion is "every column reaches the fill line", with trapped air pockets below the
  surface tamped afterwards. (Measuring coverage alone stalled at ~97 % in the first version.)
  The page above the soil line stays readable, which is the point.
- One of three kinds of flora per run, chosen at random, on a persistent device-resolution
  canvas: ground flowers that carpet the dirt to about three-quarters density, vines that climb
  both edges of the window like a trellis, or flowering bushes that rise from the soil line to
  fill roughly the next quarter of the window. See `docs/spike0-flowers.png`,
  `docs/spike0-vines.png`, `docs/spike0-bushes.png`. The bushes have thin trunks and can read as
  floating blobs where the soil surface is bumpy; the vines-only run leaves the mound itself
  bare. Both are Phase 2 art direction, not mechanics.
- Two stacked canvases (dirt at grid resolution, growth at device resolution) so the browser
  composites and the dirt layer stops redrawing once buried.
- Inline `!important` styles on a custom element plus Shadow DOM: the test page's
  `div { position: relative; z-index: 1 }` and `* { opacity: .999 }` rules had no effect.

Open issues: the HUD covers the top-left corner (debug only); the piece has no end-state behaviour
yet (loop idles with the garden on screen, and the HUD clock keeps ticking so a stopped heartbeat
is not mistaken for a dead loop); `prefers-reduced-motion` is ignored; the overlay is
`pointer-events: none` so the reader can still scroll the buried page, which may or may not be wanted.

## Spike A — iOS Action extension: **scaffolded, device test pending (top priority)**

What is built: a no-UI Action extension (`com.apple.ui-services`, web-page activation rule,
`NSExtensionJavaScriptPreprocessingFile = Action`). `Action.js` is `dirt-core.js` plus an
`ExtensionPreprocessingJS` wrapper whose `finalize()` calls `Dirt.start({ debug: true })`. The
native handler returns immediately, so the share sheet closes at once.

The key question — does a `requestAnimationFrame` loop started in `finalize()` keep running after
the extension is dismissed? — **Answered on a device: yes.** In direct mode (no script-tag
fallback needed), the loop ran until the garden was complete, about 35 s after the share sheet
closed, on a heavy site at 57–60 fps. The preprocessing file is injected into the page's
JavaScript context and its closures live in the page, so the loop persists like any page script.
The two fallbacks remain in place in case a site or iOS release behaves differently:

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

Verified: desktop Chrome loads `extension/` unpacked and runs the overlay (Chrome warns that
`background.scripts` is a Manifest V2 key; it is there for Firefox and is harmless). Desktop
Firefox loads the same folder as a temporary add-on and runs it (Firefox warns about the
`service_worker` key instead). On the iPhone the extension installed and ran. The enabling path (Settings → Apps → Safari → Extensions,
then the puzzle-piece menu in the address bar) is two or three more taps than the share sheet and
lives in a menu many readers never open, which is why Spike A stays primary. Not yet checked:
desktop Firefox, and whether Safari prompts per site despite `activeTab`.

## Spike C — in-app browser: **scaffolded**

`WKWebView` with the module as a `WKUserScript` (document end, main frame only), a floating Bury
button that calls `Dirt.toggle()` via `evaluateJavaScript`, and a `ping` that reads the heartbeat
from native code. Links arrive by paste, by `dirt://open?url=…`, or from the `ShareToDirt`
extension, which parks the URL in an App Group and tries the well-known responder-chain
`openURL:` trick to foreground the app. That trick is unofficial and changes between iOS
releases; the App Group handoff is the reliable fallback (reader taps the app icon).

Costs to weigh: the web view has its own cookie jar (paywalls and logins show their walls), no
content blockers, and Apple's guideline 4.2 looks hard at apps that are "just a web view". This
route is a transport for links from other apps, not the headline experience. Verified on the
iPhone: paste → Bury works. The App Group needed for the share-sheet handoff cannot be signed by
a free Personal Team, so its entitlements are opt-in in `ios/project.yml` (paid team only).

## Spike D — web fallback: **works; live survey done**

`server.mjs` probes headers (`X-Frame-Options`, CSP `frame-ancestors`) following redirects with a
mobile UA, and takes a full-page screenshot with an iPhone-14 Chromium profile (scrolls first so
lazy images load; capped at 12 000 px; 1-hour cache). `public/index.html` frames the page when
allowed and otherwise shows the screenshot in a scroll container, with Dirt fixed above either.

Live survey, 22 sites, run by Mark on 2026-10-17 with the Mac's own Google Chrome in headless
mode (`PW_CHANNEL=chrome`, because Playwright's bundled-browser installer hung on macOS; the
harness now supports both). Full table in `spike-d-web-fallback/RESULTS.md`.

| | Count | Sites |
|---|---|---|
| Frameable (no `X-Frame-Options`, no restrictive `frame-ancestors`) | 4 / 22 | Wikipedia, Amazon, Internet Archive, WSJ (but WSJ answered 401) |
| Blocked by `X-Frame-Options` | 12 / 22 | NYTimes, Guardian, BBC, Washington Post, Instagram, Reddit, YouTube, Apple, Google Maps, Davidson, samplereality.com, MDN |
| Blocked by CSP `frame-ancestors` | 6 / 22 | X, GitHub, New Yorker, Medium, Substack, Craigslist |
| Screenshot usable (HTTP 200 and taller than one screen) | 14 / 22 | Guardian, BBC, Washington Post, Wikipedia, Reddit, GitHub, New Yorker, Substack, Amazon, Apple, Internet Archive, Davidson, samplereality.com, MDN |
| Screenshot suspect | 8 / 22 | NYTimes (403 bot block), WSJ (401 bot block), Instagram and X (login walls), YouTube, Google Maps, Medium, Craigslist (one-screen app shells) |

What this means for the design:

- The iframe path is a bonus for a handful of sites, as expected. Screenshot-first is the right
  default, and the probe now treats `https://*.example.com` in `frame-ancestors` correctly as
  "not us" (an earlier version of the harness over-counted frameable sites).
- The two paywalled national papers in the set, NYTimes and WSJ, refuse headless Chrome at the
  HTTP level; the Guardian, Post, BBC and New Yorker do not. A production fallback would need
  either a browser that passes bot checks (a real Chrome profile, residential egress) or an
  honest "this site won't let us in" message. Both are policy choices for Phase 2.
- Social and app-style sites screenshot as a login wall or an empty shell. That is what a
  logged-out reader sees, and arguably on theme, but it is not an article.
- Latency is the UX cost: 2–9 s for most sites, 26–33 s for X, the New Yorker and Amazon. A
  viewport-only capture first (one screen, 1–3 s) with the full page arriving later would make
  the wait bearable; the server already supports `view=1`.
- Offline self-test (`RESULTS.LOCAL.md`) still passes: open / `DENY` / `SAMEORIGIN` /
  `frame-ancestors 'none'` verdicts are correct against synthetic pages.

Privacy and security: this is the one route where a URL leaves the reader's device. The server
logs nothing and keeps cached PNGs for an hour; a public deployment needs the private-address
block kept on, rate limiting, and a privacy note on the page.

## Recommended delivery mix for Phase 2

1. **Spike A (share-sheet Action) as the primary iOS experience.** The device test passed: one
   tap from Safari's Share menu reaches the live page, the animation survives the extension's
   dismissal, and it holds 57–60 fps on nytimes.com. Worth repeating on a couple of CSP-strict
   sites and after an iOS update, since this behaviour is undocumented by Apple.
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
