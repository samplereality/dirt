# Spike C — in-app browser (WKWebView + WKUserScript)

Covers links that never reach Safari: a URL shared from Mail, Slack, X, Instagram's browser, etc.

- `DirtBrowser/WebView.swift` — `WKWebView` with `dirt-core.js` added as a `WKUserScript`
  (`atDocumentEnd`, main frame only). The script only defines `Dirt`; the floating **Bury** button
  runs `Dirt.toggle({debug:true})` through `evaluateJavaScript`, and **ping** reads `Dirt.ping()` to
  confirm the loop is alive from native code.
- `DirtBrowser/BrowserView.swift` — address bar, paste-from-clipboard, and the receive path.
- `DirtBrowser/SharedInbox.swift` — picks up URLs from the share extension (App Group) or `dirt://open?url=…`.
- `ShareToDirt/` — share extension accepting a web URL or text. It writes the URL to the App Group,
  then tries to open the app via the responder-chain `openURL:` trick, then dismisses.

These files are compiled into the `Dirt` app target and the `ShareToDirt` extension target by `ios/project.yml`.

## Test

1. Browser tab → paste a URL → Go → Bury. Record fps / p95 from the HUD and whether the overlay
   covers WKWebView's own fixed elements (it should; it is in the page).
2. From Mail or Messages, share a link → **Share to Dirt**. Does the app open by itself (responder
   chain) or only after you tap its icon (App Group)? Record iOS version — this behaviour drifts between releases.
3. Try a paywalled site and a logged-in site: the WKWebView has its own cookie store, so the reader
   sees the logged-out page. That is a product trade-off, not a bug, but worth noting.

## Known limits

- No Safari extensions/content blockers inside WKWebView, so ad-heavy pages are heavier here than in Safari.
- Apple reviews "just a web view" apps harshly (guideline 4.2). This target is only a transport for
  links from other apps; the share sheet (Spike A) remains the primary experience.
