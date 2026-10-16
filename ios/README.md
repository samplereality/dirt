# Dirt — iOS host app and extension spikes

One Xcode project carries the host app (which is also Spike C's browser) and three extension targets:

| Target | Spike | Kind |
|---|---|---|
| `Dirt` | C | SwiftUI app with a `WKWebView` that injects `dirt-core.js` |
| `BuryWithDirt` | A | Safari **Action** extension (share sheet, `NSExtensionJavaScriptPreprocessingFile`) |
| `DirtSafariExtension` | B | Safari **Web** Extension (Manifest V3) |
| `ShareToDirt` | C | Share extension that hands a URL from any app to `Dirt` |

Sources live in the spike folders at the repo root; `project.yml` references them, so each spike folder stays self-describing.

## Generate the project

```sh
brew install xcodegen
cd ios
xcodegen generate
open Dirt.xcodeproj
```

## Signing

A free Apple ID is enough to run on your own iPhone: in Xcode → Settings → Accounts add the Apple ID, then in each target's **Signing & Capabilities** tab pick "<Your Name> (Personal Team)". Alternatively put the Team ID in `ios/Local.xcconfig` (`DEVELOPMENT_TEAM = ABCDE12345`), which is gitignored and included by `Config.xcconfig`. The project never embeds a Team ID, so it regenerates cleanly under the colleague's account later.

- "Your team has no devices": plug the iPhone in, select it as the run destination, click **Try Again**. Xcode registers the device automatically.
- "Bundle identifier unavailable": change `BUNDLE_ID_PREFIX` in `Config.xcconfig` (or override it in `Local.xcconfig`) and regenerate.
- **App Groups** (used only by Spike C's share-sheet handoff) require a paid team, so the entitlements are commented out in `project.yml`. On a paid team, uncomment the two `CODE_SIGN_ENTITLEMENTS` lines and regenerate; Xcode registers `group.<prefix>.dirt` automatically and it transfers with the app.
- A Personal Team build expires after 7 days; re-run from Xcode to refresh.

Regenerate `spike-a-ios-action-extension/BuryWithDirt/Resources/Action.js` with `sh build.sh` from the repo root whenever `dirt-core.js` changes (the Action extension needs the core inlined into a single file).

## Without XcodeGen

Create an iOS App in Xcode (SwiftUI, Swift), then File → New → Target for each of: **Action Extension** (uncheck "presents user interface"), **Safari Extension**, **Share Extension**. Replace the generated Swift / Info.plist / JS files with the ones in the spike folders, add `dirt-core.js` to the app target and the Safari extension target as bundle resources, and add `Action.js` to the Action extension's resources. Add the App Group capability to `Dirt` and `ShareToDirt`.

## Testing on a device

Run the `Dirt` scheme on an iPhone (all extensions embed into the app). Then follow the checklist in the app's **Spikes** tab. The HUD printed by `Dirt.start({ debug: true })` shows fps, p95 frame time and a heartbeat counter; it is the measurement instrument for every spike.
