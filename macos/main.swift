import AppKit
import Security
import WebKit

private enum DialConfiguration {
    static let startURL = URL(string: "https://lheinen002-prog.github.io/dial/")!
    static let allowedHost = "lheinen002-prog.github.io"
    static let allowedPathRoot = "/dial"
    static let bridgeName = "dialKeychainNative"

    static func isAllowedAppURL(_ url: URL?) -> Bool {
        guard let url else { return false }

        if url.scheme == "about" {
            return url.absoluteString == "about:blank"
        }

        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == allowedHost else {
            return false
        }

        let path = url.path
        return path == allowedPathRoot || path.hasPrefix(allowedPathRoot + "/")
    }

    static func isTrustedBridgeFrame(_ frame: WKFrameInfo) -> Bool {
        frame.isMainFrame && isAllowedAppURL(frame.request.url)
    }

    static func isExternalWebURL(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "https" || scheme == "http"
    }
}

private enum DialKeychainError: LocalizedError {
    case invalidToken
    case invalidEncoding
    case securityStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidToken:
            return "The token must be a non-empty string smaller than 16 KB."
        case .invalidEncoding:
            return "The saved token could not be decoded."
        case .securityStatus(let status):
            return (SecCopyErrorMessageString(status, nil) as String?)
                ?? "Keychain operation failed with status \(status)."
        }
    }
}

private enum DialKeychain {
    private static let service = "com.lmh.lucashq.v2"
    private static let account = "dial-sync-token"

    private static var lookupQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    static func readToken() throws -> String? {
        var query = lookupQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw DialKeychainError.securityStatus(status)
        }
        guard let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw DialKeychainError.invalidEncoding
        }
        return token
    }

    static func writeToken(_ token: String) throws {
        guard !token.isEmpty, token.utf8.count <= 16 * 1024 else {
            throw DialKeychainError.invalidToken
        }

        let data = Data(token.utf8)
        let update = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(
            lookupQuery as CFDictionary,
            update as CFDictionary
        )

        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw DialKeychainError.securityStatus(updateStatus)
        }

        var attributes = lookupQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw DialKeychainError.securityStatus(addStatus)
        }
    }

    static func deleteToken() throws {
        let status = SecItemDelete(lookupQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw DialKeychainError.securityStatus(status)
        }
    }
}

private final class DialKeychainBridge: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard DialConfiguration.isTrustedBridgeFrame(message.frameInfo) else {
            replyHandler(["ok": false, "error": "Untrusted page origin."], nil)
            return
        }
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            replyHandler(["ok": false, "error": "Malformed Keychain request."], nil)
            return
        }

        do {
            switch action {
            case "getToken":
                if let token = try DialKeychain.readToken() {
                    replyHandler(["ok": true, "value": token], nil)
                } else {
                    replyHandler(["ok": true, "value": NSNull()], nil)
                }

            case "setToken":
                guard let token = body["token"] as? String else {
                    throw DialKeychainError.invalidToken
                }
                try DialKeychain.writeToken(token)
                replyHandler(["ok": true, "value": true], nil)

            case "deleteToken":
                try DialKeychain.deleteToken()
                replyHandler(["ok": true, "value": true], nil)

            default:
                replyHandler(["ok": false, "error": "Unsupported Keychain action."], nil)
            }
        } catch {
            replyHandler(
                ["ok": false, "error": error.localizedDescription],
                nil
            )
        }
    }
}

private final class DownloadCoordinator: NSObject, WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        guard let downloadsDirectory = FileManager.default.urls(
            for: .downloadsDirectory,
            in: .userDomainMask
        ).first else {
            completionHandler(nil)
            return
        }

        let safeName = suggestedFilename
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")

        var destination = downloadsDirectory.appendingPathComponent(safeName)
        let stem = destination.deletingPathExtension().lastPathComponent
        let ext = destination.pathExtension
        var suffix = 2

        while FileManager.default.fileExists(atPath: destination.path) {
            let candidate = ext.isEmpty
                ? "\(stem)-\(suffix)"
                : "\(stem)-\(suffix).\(ext)"
            destination = downloadsDirectory.appendingPathComponent(candidate)
            suffix += 1
        }

        completionHandler(destination)
    }
}

private final class NavigationGuard: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let downloads = DownloadCoordinator()

    private func sourceIsTrusted(_ action: WKNavigationAction) -> Bool {
        DialConfiguration.isAllowedAppURL(action.sourceFrame.request.url)
    }

    private func openExternallyIfUserInitiated(_ action: WKNavigationAction) {
        guard action.navigationType == .linkActivated,
              let url = action.request.url,
              DialConfiguration.isExternalWebURL(url) else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        if url.scheme?.lowercased() == "blob", sourceIsTrusted(navigationAction) {
            decisionHandler(
                navigationAction.shouldPerformDownload ? .download : .allow
            )
            return
        }

        if DialConfiguration.isAllowedAppURL(url) {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
            return
        }

        openExternallyIfUserInitiated(navigationAction)
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = navigationAction.request.url else {
            return nil
        }

        if DialConfiguration.isAllowedAppURL(url) {
            webView.load(navigationAction.request)
        } else if navigationAction.navigationType == .linkActivated,
                  DialConfiguration.isExternalWebURL(url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = downloads
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = downloads
    }
}

private final class DialWindowController: NSWindowController {
    private let webView: WKWebView
    private let keychainBridge: DialKeychainBridge
    private let navigationGuard: NavigationGuard

    init() {
        keychainBridge = DialKeychainBridge()
        navigationGuard = NavigationGuard()

        let contentController = WKUserContentController()
        contentController.addScriptMessageHandler(
            keychainBridge,
            contentWorld: .page,
            name: DialConfiguration.bridgeName
        )

        let bridgeSource = """
        (() => {
          const nativeBridge =
            window.webkit?.messageHandlers?.\(DialConfiguration.bridgeName);
          if (!nativeBridge || Object.prototype.hasOwnProperty.call(window, "dialKeychain")) {
            return;
          }

          const call = (action, payload = {}) =>
            Promise.resolve(nativeBridge.postMessage({ action, ...payload }))
              .then((reply) => {
                if (!reply || reply.ok !== true) {
                  throw new Error(reply?.error || "Keychain operation failed.");
                }
                return reply.value ?? null;
              });

          Object.defineProperty(window, "dialKeychain", {
            configurable: false,
            enumerable: true,
            writable: false,
            value: Object.freeze({
              available: true,
              getToken: () => call("getToken"),
              setToken: (token) => call("setToken", { token }),
              deleteToken: () => call("deleteToken")
            })
          });
        })();
        """

        contentController.addUserScript(
            WKUserScript(
                source: bridgeSource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true,
                in: .page
            )
        )

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "DIALMac/1.0"
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: configuration)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        super.init(window: window)

        window.title = "DIAL"
        window.minSize = NSSize(width: 390, height: 680)
        window.backgroundColor = NSColor(
            calibratedRed: 11 / 255,
            green: 14 / 255,
            blue: 20 / 255,
            alpha: 1
        )
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("DIALMainWindow")

        webView.navigationDelegate = navigationGuard
        webView.uiDelegate = navigationGuard
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func loadDIAL() {
        webView.load(
            URLRequest(
                url: DialConfiguration.startURL,
                cachePolicy: .useProtocolCachePolicy,
                timeoutInterval: 30
            )
        )
    }

    func reloadDIAL() {
        webView.reload()
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var dialWindowController: DialWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()

        let controller = DialWindowController()
        dialWindowController = controller
        controller.showWindow(nil)
        controller.loadDIAL()

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(
        _ sender: NSApplication
    ) -> Bool {
        true
    }

    @objc private func reloadDIAL(_ sender: Any?) {
        dialWindowController?.reloadDIAL()
    }

    private func installMainMenu() {
        let mainMenu = NSMenu(title: "DIAL")

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: "DIAL")
        appMenu.addItem(
            withTitle: "About DIAL",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Hide DIAL",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit DIAL",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(
            withTitle: "Undo",
            action: Selector(("undo:")),
            keyEquivalent: "z"
        )
        editMenu.addItem(.separator())
        editMenu.addItem(
            withTitle: "Cut",
            action: #selector(NSText.cut(_:)),
            keyEquivalent: "x"
        )
        editMenu.addItem(
            withTitle: "Copy",
            action: #selector(NSText.copy(_:)),
            keyEquivalent: "c"
        )
        editMenu.addItem(
            withTitle: "Paste",
            action: #selector(NSText.paste(_:)),
            keyEquivalent: "v"
        )
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let reloadItem = NSMenuItem(
            title: "Reload DIAL",
            action: #selector(reloadDIAL(_:)),
            keyEquivalent: "r"
        )
        reloadItem.target = self
        viewMenu.addItem(reloadItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        NSApp.mainMenu = mainMenu
    }
}

let application = NSApplication.shared
private let applicationDelegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = applicationDelegate
application.run()
