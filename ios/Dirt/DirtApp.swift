import SwiftUI

/// Host app for the Phase-1 spikes. It exists to carry the extensions (Spikes A and B) and to run
/// the in-app browser (Spike C). No analytics, no network calls of its own.
@main
struct DirtApp: App {
    @StateObject private var inbox = SharedInbox()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(inbox)
                .onOpenURL { url in inbox.handle(openURL: url) }
        }
    }
}

struct ContentView: View {
    var body: some View {
        TabView {
            BrowserView()
                .tabItem { Label("Browser", systemImage: "globe") }
            SetupNotesView()
                .tabItem { Label("Spikes", systemImage: "list.bullet.clipboard") }
        }
    }
}

/// Plain-language checklist shown in the app so testing on a device needs no laptop at hand.
struct SetupNotesView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("Spike A — share sheet") {
                    Text("In Safari, tap Share, scroll the action row, tap “Bury with Dirt”. (First time: tap “Edit Actions…” and enable it.)")
                    Text("Watch the HUD in the corner: if the heartbeat number keeps rising after the share sheet closes, the animation survived.")
                }
                Section("Spike B — Safari extension") {
                    Text("Settings → Apps → Safari → Extensions → Dirt Safari Extension → On. Then in Safari tap the puzzle/“aA” menu → Bury with Dirt.")
                }
                Section("Spike C — in-app browser") {
                    Text("Paste a URL in the Browser tab, or share a link from any app to “Share to Dirt”, then open this app.")
                }
                Section("Record") {
                    Text("Device, iOS version, site, fps / p95 frame from the HUD, and whether the overlay sat above sticky headers and fixed bars.")
                }
            }
            .navigationTitle("Dirt spikes")
        }
    }
}
