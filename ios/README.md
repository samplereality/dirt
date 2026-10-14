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

Set your Team ID in `Config.xcconfig` (`DEVELOPMENT_TEAM = ABCDE12345`) — do not commit it. The project never embeds a Team ID, so it can be regenerated under the colleague's account later. The one team-bound resource is the App Group `group.<prefix>.dirt`, which Xcode registers automatically when signing is automatic; it transfers with the app.

Regenerate `spike-a-ios-action-extension/BuryWithDirt/Resources/Action.js` with `sh build.sh` from the repo root whenever `dirt-core.js` changes (the Action extension needs the core inlined into a single file).

## Without XcodeGen

Create an iOS App in Xcode (SwiftUI, Swift), then File → New → Target for each of: **Action Extension** (uncheck "presents user interface"), **Safari Extension**, **Share Extension**. Replace the generated Swift / Info.plist / JS files with the ones in the spike folders, add `dirt-core.js` to the app target and the Safari extension target as bundle resources, and add `Action.js` to the Action extension's resources. Add the App Group capability to `Dirt` and `ShareToDirt`.

## Testing on a device

Run the `Dirt` scheme on an iPhone (all extensions embed into the app). Then follow the checklist in the app's **Spikes** tab. The HUD printed by `Dirt.start({ debug: true })` shows fps, p95 frame time and a heartbeat counter; it is the measurement instrument for every spike.
