import SafariServices

/// Required principal class for a Safari Web Extension. Dirt never messages native code, so this
/// just acknowledges any message; it exists because the extension point needs a handler.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
