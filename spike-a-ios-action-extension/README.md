# Spike A — iOS Action extension ("Bury with Dirt" in Safari's share sheet)

**Top-priority spike.** A no-UI Action extension whose `Info.plist` names `Action` as its
`NSExtensionJavaScriptPreprocessingFile`. Safari injects `Resources/Action.js` into the live page:
`run()` fires when the share sheet opens, `finalize()` fires after the native side completes the
request. `finalize()` calls `Dirt.start({ debug: true })`.

Files

- `BuryWithDirt/ActionRequestHandler.swift` — completes the request immediately, passing `{action:"start", debug:true}` to `finalize()`.
- `BuryWithDirt/Info.plist` — `com.apple.ui-services` extension point, web-page activation rule, no UI.
- `BuryWithDirt/Resources/action-wrapper.js` — the `ExtensionPreprocessingJS` object.
- `BuryWithDirt/Resources/Action.js` — **generated** by `sh build.sh` at the repo root (= `dirt-core.js` + embedded source string + wrapper). Commit it so the Xcode project builds without a script step.

## The key question

Does an animation started from `finalize()` keep running after the extension dismisses?

How to test on a real iPhone:

1. Build and run the `Dirt` scheme (see `ios/README.md`). Open Safari, load a heavy page (nytimes.com, theguardian.com, a page with many ads).
2. Share → scroll the action row → **Bury with Dirt** (first time: *Edit Actions…* → enable).
3. Watch the HUD in the top-left corner. The `heartbeat` number is the frame counter.
   - Keeps rising after the share sheet is gone → the loop survives. Record fps and p95 from the HUD at ~10 s (dirt) and ~30 s (growth).
   - Freezes or the overlay disappears → Safari tore down the injected script context. Switch `DIRT_INJECT_MODE` to `'script-tag'` in `action-wrapper.js`, rebuild, and retest; that copies the module into the page's own world. Record which sites block it (Content-Security-Policy without `'unsafe-inline'`).
4. Repeat after: scrolling the page, rotating the phone, backgrounding Safari for 10 s, tapping a link.

Record per site: survived (y/n), inject mode that worked, fps / p95, overlay above sticky header and fixed bars (y/n), anything odd (page reload, overlay behind a `transform`ed ancestor, address-bar resize glitches).

## Expected friction

- The action must be enabled once in the share sheet's *Edit Actions…* list; Apple shows it with a monochrome icon and the display name from `CFBundleDisplayName`.
- The JS preprocessing file runs only for web pages in Safari (and SFSafariViewController). Links in other apps' WKWebViews do not get it — that gap is Spike C's reason to exist.
- Nothing leaves the device. The extension reads `document.title` and `document.URL` only to echo them back for debugging; remove that in Phase 2.
