import Combine
import Foundation
import Network
import UIKit
import WebKit

@MainActor
final class WorkspaceBrowser: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    @Published private(set) var workspaces: [Workspace] = []
    @Published private(set) var active: Workspace?
    @Published private(set) var loading = false
    @Published private(set) var progress = 0.0
    @Published private(set) var offline = false
    @Published private(set) var failed = false
    @Published private(set) var isWorkspacePage = false
    @Published var showSettings = false
    @Published var pendingWorkspace: Workspace?
    @Published var externalPage: BrowserPage?
    @Published var sharedFile: SharedFile?
    @Published var downloadFailed = false
    @Published var webDialog: WebDialog?

    let webView: WKWebView
    private let monitor = NWPathMonitor()
    private var observations: [NSKeyValueObservation] = []
    private var deadline: Task<Void, Never>?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private let preferences: UserDefaults
    #if DEBUG
    private let entryProbe = ProcessInfo.processInfo.arguments.contains("--acceptance-account-entry")
    private var entryTransitions = 0
    private func recordEntryProbe(_ result: String) {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("account-entry-probe.json")
        let data = try? JSONSerialization.data(withJSONObject: ["result": result, "transitions": entryTransitions])
        try? data?.write(to: url)
    }
    #endif

    init(preferences: UserDefaults = .standard) {
        #if DEBUG
        self.preferences = ProcessInfo.processInfo.arguments.contains("--acceptance-account-entry") ? UserDefaults(suiteName: "ai.qoopia.ios.entry-acceptance")! : preferences
        #else
        self.preferences = preferences
        #endif
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // No native message bridge or injected credentials. Server owner checks remain authoritative.
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        config.applicationNameForUserAgent = "Qoopia-iOS/3"
        #if DEBUG
        if entryProbe {
            // Exercise actual WebKit navigation without account cookies or private workspace data.
            config.websiteDataStore = .nonPersistent()
            config.userContentController.addUserScript(WKUserScript(source: "if(location.href === 'https://auth.qoopia.ai/profile?app=ios') location.replace('https://mcp.qoopia.ai/dashboard?signin=account');", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        #endif
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        workspaces = (self.preferences.stringArray(forKey: "workspaceOrigins") ?? []).compactMap { try? Workspace($0) }
        active = workspaces.first { $0.id == self.preferences.string(forKey: "activeWorkspace") }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--acceptance-workspaces") || ProcessInfo.processInfo.arguments.contains("--acceptance-unavailable") {
            // Simulator-only synthetic states. No account, network request or real preference writes.
            let demo = try! Workspace("https://workspace.example")
            workspaces = [demo]
            active = demo
            offline = ProcessInfo.processInfo.arguments.contains("--acceptance-unavailable")
            failed = offline
            return
        }
        #endif
        observations = [
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in self?.progress = view.estimatedProgress }
            }
        ]
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in self?.offline = path.status != .satisfied }
        }
        monitor.start(queue: DispatchQueue(label: "ai.qoopia.network"))
        #if DEBUG
        if entryProbe { workspaces = []; active = nil }
        #endif
        open(active)
    }

    func open(_ workspace: Workspace?) {
        active = workspace
        preferences.set(workspace?.id, forKey: "activeWorkspace")
        failed = false
        isWorkspacePage = workspace != nil
        let url = workspace.map { URL(string: $0.dashboard.absoluteString + "?signin=account")! } ?? URLPolicy.account
        webView.load(URLRequest(url: url, timeoutInterval: 30))
    }

    private func remember(_ workspace: Workspace) {
        if !workspaces.contains(workspace) { workspaces.append(workspace) }
        preferences.set(workspaces.map(\.id), forKey: "workspaceOrigins")
        active = workspace
        preferences.set(workspace.id, forKey: "activeWorkspace")
        pendingWorkspace = nil
    }

    func add(_ workspace: Workspace) {
        remember(workspace)
        open(workspace)
    }

    func forget(_ workspace: Workspace) {
        workspaces.removeAll { $0 == workspace }
        preferences.set(workspaces.map(\.id), forKey: "workspaceOrigins")
        if active == workspace { open(nil) }
    }

    func reload() {
        failed = false
        if webView.url != nil { webView.reload() } else { open(active) }
    }

    func resume() {
        if failed && !offline { reload() }
        else if let url = webView.url, URLPolicy.sameOrigin(URLPolicy.account, url) {
            // Wake the existing email-confirmation poll after returning from Mail or Safari.
            webView.evaluateJavaScript("window.dispatchEvent(new Event('pageshow'))", completionHandler: nil)
        }
    }

    func stop() { deadline?.cancel(); webView.stopLoading(); loading = false }

    func clearSessions() async {
        stop()
        await webView.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        open(nil)
    }

    func clearSharedFile() {
        if let file = sharedFile { try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent()) }
        sharedFile = nil
    }

    func answerDialog(_ value: String?) {
        let dialog = webDialog
        webDialog = nil
        dialog?.answer(value)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        webDialog = WebDialog(kind: .message, message: String(message.prefix(2000)), initial: "") { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        webDialog = WebDialog(kind: .confirm, message: String(message.prefix(2000)), initial: "") { completionHandler($0 != nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (String?) -> Void) {
        webDialog = WebDialog(kind: .input, message: String(prompt.prefix(2000)), initial: defaultText ?? "", answer: completionHandler)
    }

    // Retains the web dashboard's full functionality, including server-provided permissions.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "qoopia-app://settings", action.navigationType == .linkActivated,
           let source = action.sourceFrame.request.url, active?.contains(source) == true {
            decisionHandler(.cancel); showSettings = true; return
        }
        if action.sourceFrame.isMainFrame, let workspace = URLPolicy.accountWorkspace(url, from: action.sourceFrame.request.url) {
            #if DEBUG
            if entryProbe {
                entryTransitions += 1
                if entryTransitions > 2 { recordEntryProbe("navigation-loop"); decisionHandler(.cancel); return }
            }
            #endif
            // Let WebKit finish this request. Cancelling then loading here re-enters
            // this delegate while the source frame is still the account page.
            remember(workspace)
            decisionHandler(.allow)
            return
        }
        let trusted = URLPolicy.sameOrigin(URLPolicy.account, url) || active?.contains(url) == true
        if action.shouldPerformDownload {
            decisionHandler(trusted ? .download : .cancel)
            return
        }
        if action.targetFrame?.isMainFrame == false {
            decisionHandler(trusted ? .allow : .cancel)
            return
        }
        if trusted && action.targetFrame != nil {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        guard action.navigationType == .linkActivated else { return }
        if let workspace = URLPolicy.workspaceLink(url) {
            if let saved = workspaces.first(where: { $0 == workspace }) { open(saved) }
            else { pendingWorkspace = workspace }
        } else if URLPolicy.safeExternal(url) {
            if url.scheme == "https" { externalPage = BrowserPage(url: url) }
            else { UIApplication.shared.open(url) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        guard let url = response.response.url,
              URLPolicy.sameOrigin(URLPolicy.account, url) || active?.contains(url) == true else {
            decisionHandler(.cancel); return
        }
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        decisionHandler(!response.canShowMIMEType || attachment ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading = true
        failed = false
        deadline?.cancel()
        deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(35))
            guard !Task.isCancelled, let self, self.loading else { return }
            self.webView.stopLoading()
            self.loading = false
            self.failed = true
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        #if DEBUG
        if entryProbe, let url = webView.url, url.path == "/dashboard", active?.contains(url) == true {
            recordEntryProbe("workspace-committed")
        }
        #endif
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        deadline?.cancel(); loading = false; failed = false
        isWorkspacePage = webView.url.map { active?.contains($0) == true && $0.path == "/dashboard" } ?? false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failedNavigation(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failedNavigation(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loading = false; failed = true }

    private func failedNavigation(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        deadline?.cancel(); loading = false; failed = true
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        guard let url = response.url, active?.contains(url) == true else { completionHandler(nil); return }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("qoopia-export-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            let name = (suggestedFilename as NSString).lastPathComponent
            let destination = directory.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "Qoopia-file" : name)
            downloads[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch { downloadFailed = true; completionHandler(nil) }
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            clearSharedFile()
            sharedFile = SharedFile(url: file)
        }
        loading = false
        deadline?.cancel()
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        downloadFailed = true
        loading = false
        deadline?.cancel()
    }
}

struct BrowserPage: Identifiable { let id = UUID(); let url: URL }
struct SharedFile: Identifiable { let id = UUID(); let url: URL }
struct WebDialog: Identifiable {
    enum Kind { case message, confirm, input }
    let id = UUID()
    let kind: Kind
    let message: String
    let initial: String
    let answer: @MainActor (String?) -> Void
}
