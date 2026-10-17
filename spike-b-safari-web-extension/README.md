# Spike B — Safari Web Extension (Manifest V3), bundled in the same app

`extension/` is a plain cross-browser MV3 extension: a toolbar/menu **action** that runs
`scripting.executeScript` with `activeTab` to inject `dirt-core.js` and then `inject.js`. No
content scripts run on page load; no host permissions.

Phase 2 (0.4): the extension **remembers gardens, and brings them back at page load.**

- First click on a page: `background.js` asks, inside the click, for permission to run on that
  *site* (the browser's own per-site prompt; nothing is asked at install), then injects the core.
  When the burial finishes, `inject.js` sends `Dirt.export()` to the background, which keeps it in
  `storage.local` under the page URL (hash stripped).
- Revisit that page on an allowed site: `autorestore.js` (a content script that runs on allowed
  sites only, at `document_idle`) asks the background for the saved scene and restores it with no
  click and no HUD. If the site was not allowed, the garden still comes back on the next click.
- Click while Dirt is on screen: clears it. "Forget this garden" will live in the album.
- Permissions: `activeTab`, `scripting`, `storage`, plus optional site access declared as
  `optional_host_permissions` (Chrome) and as host patterns in `optional_permissions` (Firefox,
  Safari); each browser warns about the key it does not use. Nothing leaves the browser.

Verified in headless Chromium with Playwright (`localhost` pre-granted): bury → save → reload →
restored without a click. The per-site prompt itself needs a real browser: on the first click on
a site, Chrome shows "Allow Dirt to read and change data on …?"; Firefox and Safari show their
usual site-access prompt.

- `extension/manifest.json`, `background.js`, `inject.js`, `autorestore.js`, `dirt-core.js` (copied in by `sh build.sh`)
- `DirtSafariExtension/` — the Swift shell Safari requires (`com.apple.Safari.web-extension`). The
  extension files are copied flat into the `.appex` so `manifest.json` sits at the bundle's resource root.

## On iPhone

1. Run the `Dirt` scheme on the phone (`ios/README.md`).
2. Settings → Apps → Safari → Extensions → **Dirt Safari Extension** → on. (iOS 15–17: Settings → Safari → Extensions.)
3. In Safari open a page, tap the **puzzle piece / “aA”** menu in the address bar → **Bury with Dirt**. Safari may ask to allow the extension on this site (one day / always) the first time.

Record: the number of taps to enable it, whether Safari prompted per site despite `activeTab`, fps / p95 from the HUD, and whether tapping again removes the overlay (toggle).

`background.service_worker` is honoured by Safari 16.4+ and Chrome; Firefox uses `background.scripts`
(both keys are present, each browser warns about the one it ignores). Safari also supports a
non-persistent background page, which is a fallback if the service worker misbehaves on iOS.

## Same code on desktop

- **Chrome**: chrome://extensions → Developer mode → *Load unpacked* → `extension/`. Click the toolbar icon.
- **Firefox** (121+): about:debugging → This Firefox → *Load Temporary Add-on* → `extension/manifest.json`.
- **Safari (macOS)**: the same `DirtSafariExtension` target in a macOS build; or `xcrun safari-web-extension-converter extension/` to generate a throwaway project.

Expected result: identical behaviour, since the code uses only `action`, `scripting` and `activeTab`.
Verify on desktop first — it is a two-minute check and de-risks the iOS run.
