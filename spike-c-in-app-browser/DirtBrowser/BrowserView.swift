import SwiftUI

/// Spike C — in-app browser. Paste or share a URL, the page loads in a WKWebView with
/// dirt-core.js pre-injected as a WKUserScript, and the floating button starts Dirt.
struct BrowserView: View {
    @EnvironmentObject private var inbox: SharedInbox
    @StateObject private var web = WebViewStore()
    @State private var address = "https://en.wikipedia.org/wiki/Soil"
    @State private var heartbeat = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("https://…", text: $address)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(load)
                Button("Go", action: load)
                Button { inbox.pasteFromClipboard() } label: { Image(systemName: "doc.on.clipboard") }
            }
            .padding(8)

            ZStack(alignment: .bottomTrailing) {
                WebView(store: web)
                VStack(alignment: .trailing, spacing: 8) {
                    if !heartbeat.isEmpty {
                        Text(heartbeat).font(.caption.monospaced()).padding(6).background(.thinMaterial).cornerRadius(6)
                    }
                    Button {
                        // Same entry point every other spike uses. Toggle so a second tap clears it.
                        web.evaluate("Dirt.toggle({debug:true}); Dirt.phase") { result in
                            heartbeat = "phase: \(result ?? "?")"
                        }
                    } label: {
                        Label("Bury", systemImage: "leaf.fill").font(.headline).padding(12)
                    }
                    .buttonStyle(.borderedProminent).tint(Color(red: 0.42, green: 0.27, blue: 0.15))
                    Button("ping") {
                        web.evaluate("Dirt.ping()") { result in heartbeat = "heartbeat: \(result ?? "-")" }
                    }.font(.caption)
                }
                .padding(16)
            }
        }
        .onAppear(perform: load)
        .onReceive(inbox.$pendingURL.compactMap { $0 }) { url in
            address = url.absoluteString
            load()
            inbox.pendingURL = nil
        }
    }

    private func load() {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        guard let url = URL(string: text) else { return }
        web.load(url)
    }
}
