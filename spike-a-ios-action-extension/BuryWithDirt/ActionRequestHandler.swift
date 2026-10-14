import UIKit
import UniformTypeIdentifiers

/// Spike A — Safari Action extension with no user interface.
///
/// Flow: the user taps "Bury with Dirt" in Safari's share sheet → Safari runs `run()` from
/// `Action.js` inside the page and hands its result here → we complete the request immediately,
/// passing a small dictionary back → Safari runs `finalize()` in the page, which calls `Dirt.start()`.
///
/// Nothing is stored or sent anywhere. The native side is deliberately trivial; the whole
/// experiment is whether the animation started in `finalize()` keeps running.
final class ActionRequestHandler: NSObject, NSExtensionRequestHandling {
    private var extensionContext: NSExtensionContext?

    func beginRequest(with context: NSExtensionContext) {
        extensionContext = context
        let plistType = UTType.propertyList.identifier

        for case let item as NSExtensionItem in context.inputItems {
            for provider in item.attachments ?? [] where provider.hasItemConformingToTypeIdentifier(plistType) {
                provider.loadItem(forTypeIdentifier: plistType, options: nil) { [weak self] loaded, _ in
                    let dict = loaded as? [String: Any]
                    let results = dict?[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any] ?? [:]
                    DispatchQueue.main.async { self?.finish(results: results) }
                }
                return
            }
        }
        finish(results: [:])
    }

    private func finish(results: [String: Any]) {
        // Everything in `payload` arrives in Action.js as the argument to finalize().
        let payload: [String: Any] = [
            "action": "start",
            "debug": true,
            "echo": results        // what run() reported (title, url, heartbeat) — handy when debugging
        ]
        let args: [String: Any] = [NSExtensionJavaScriptFinalizeArgumentKey: payload]
        let item = NSExtensionItem()
        item.attachments = [NSItemProvider(item: args as NSDictionary, typeIdentifier: UTType.propertyList.identifier)]
        extensionContext?.completeRequest(returningItems: [item], completionHandler: nil)
        extensionContext = nil
    }
}
