import UIKit
import UniformTypeIdentifiers

/// Share extension: receives a URL from any app's share sheet, parks it in the App Group, tries to
/// open the Dirt app, and dismisses. No UI beyond a brief label.
final class ShareViewController: UIViewController {
    private let appGroup = "group." + (Bundle.main.object(forInfoDictionaryKey: "DirtBundlePrefix") as? String ?? "org.dirtproject") + ".dirt"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.text = "Sending to Dirt…"
        label.textAlignment = .center
        label.frame = view.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
        extractURL { [weak self] url in
            DispatchQueue.main.async { self?.deliver(url) }
        }
    }

    private func extractURL(_ done: @escaping (URL?) -> Void) {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap { $0.attachments ?? [] } ?? []
        if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            p.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in done(item as? URL) }
        } else if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) {
            p.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in done((item as? String).flatMap(URL.init(string:))) }
        } else {
            done(nil)
        }
    }

    private func deliver(_ url: URL?) {
        guard let url = url else { finish(); return }
        UserDefaults(suiteName: appGroup)?.set(url.absoluteString, forKey: "pendingURL")
        var comps = URLComponents()
        comps.scheme = "dirt"; comps.host = "open"
        comps.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
        if let deepLink = comps.url { openHostApp(deepLink) }
        finish()
    }

    /// Extensions have no UIApplication, but walking the responder chain reaches one that answers
    /// `openURL:`. Widely used, not officially documented — treat as a finding, not a foundation.
    /// If it stops working, the App Group handoff above still delivers the URL on next launch.
    private func openHostApp(_ url: URL) {
        let selector = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while let r = responder {
            if r !== self, r.responds(to: selector) {
                _ = r.perform(selector, with: url)
                return
            }
            responder = r.next
        }
    }

    private func finish() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }
}
