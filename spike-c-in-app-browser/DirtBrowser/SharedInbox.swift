import Foundation
import Combine
import UIKit

/// Receives URLs handed to the app by the ShareToDirt extension (via the App Group) or by the
/// `dirt://open?url=…` scheme, and offers the clipboard as a manual fallback.
final class SharedInbox: ObservableObject {
    static let appGroup = "group." + (Bundle.main.object(forInfoDictionaryKey: "DirtBundlePrefix") as? String ?? "org.dirtproject") + ".dirt"
    static let pendingKey = "pendingURL"

    @Published var pendingURL: URL?

    init() {
        NotificationCenter.default.addObserver(self, selector: #selector(checkInbox), name: UIApplication.didBecomeActiveNotification, object: nil)
        checkInbox()
    }

    /// `dirt://open?url=https://…`
    func handle(openURL url: URL) {
        guard url.scheme == "dirt",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let raw = comps.queryItems?.first(where: { $0.name == "url" })?.value,
              let target = URL(string: raw) else { return }
        pendingURL = target
    }

    @objc func checkInbox() {
        let defaults = UserDefaults(suiteName: Self.appGroup)
        if let raw = defaults?.string(forKey: Self.pendingKey), let url = URL(string: raw) {
            defaults?.removeObject(forKey: Self.pendingKey)
            pendingURL = url
        }
    }

    /// Reads the clipboard only when the user asks (iOS shows a paste banner).
    func pasteFromClipboard() {
        if let url = UIPasteboard.general.url { pendingURL = url; return }
        if let text = UIPasteboard.general.string, let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme?.hasPrefix("http") == true {
            pendingURL = url
        }
    }
}
