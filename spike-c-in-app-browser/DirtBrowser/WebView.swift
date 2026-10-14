import SwiftUI
import WebKit

/// Owns the WKWebView so SwiftUI views can drive it.
final class WebViewStore: ObservableObject {
    let webView: WKWebView

    init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // Inject the module into the main frame at document end. It only defines `Dirt`; nothing
        // starts until the user taps Bury. forMainFrameOnly keeps it out of ad iframes.
        if let url = Bundle.main.url(forResource: "dirt-core", withExtension: "js"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            let script = WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            config.userContentController.addUserScript(script)
        } else {
            assertionFailure("dirt-core.js missing from the app bundle")
        }
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
    }

    func load(_ url: URL) { webView.load(URLRequest(url: url)) }

    func evaluate(_ js: String, completion: @escaping (String?) -> Void) {
        webView.evaluateJavaScript(js) { value, error in
            if let error = error { completion("error: \(error.localizedDescription)"); return }
            completion(value.map { "\($0)" })
        }
    }
}

struct WebView: UIViewRepresentable {
    @ObservedObject var store: WebViewStore
    func makeUIView(context: Context) -> WKWebView { store.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
