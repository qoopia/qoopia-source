import AppKit
import WebKit
import ServiceManagement
#if canImport(Sparkle)
import Sparkle
#endif

final class Launcher: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var child: Process?
    var clientAuth: Process?
    var preparing: Process?
    var connecting = false
    var shuttingDown = false
    var statusItem: NSStatusItem!
    var window: NSWindow!
    var webView: WKWebView!
    var statusLabel: NSTextField!
    var progress: NSProgressIndicator!
    var workspaceURL: URL?
    var outputBuffer = ""
    var loginItem: NSMenuItem!
    let executable = Bundle.main.resourceURL!.appendingPathComponent("bundle/qoopia")
    let ru = Locale.preferredLanguages.first?.hasPrefix("ru") == true
    #if canImport(Sparkle)
    var updater: SPUStandardUpdaterController?
    #endif
    func text(_ en: String, _ russian: String) -> String { ru ? russian : en }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(), item = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: text("Open Qoopia", "Открыть Qoopia"), action: #selector(showWindow), keyEquivalent: "0").target = self
        appMenu.addItem(withTitle: text("Check for Updates…", "Проверить обновления…"), action: #selector(checkUpdates), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: text("Quit Qoopia", "Выйти из Qoopia"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; menu.addItem(item)
        let edit = NSMenuItem(), editMenu = NSMenu(title: text("Edit", "Правка"))
        for (name, action, key) in [(text("Cut", "Вырезать"), "cut:", "x"), (text("Copy", "Копировать"), "copy:", "c"), (text("Paste", "Вставить"), "paste:", "v"), (text("Select All", "Выделить всё"), "selectAll:", "a")] {
            editMenu.addItem(withTitle: name, action: Selector(action), keyEquivalent: key)
        }
        edit.submenu = editMenu; menu.addItem(edit); NSApp.mainMenu = menu
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("QoopiaTray.tiff"))
        statusItem.button?.image?.size = NSSize(width: 20, height: 18)
        statusItem.button?.setAccessibilityLabel("Qoopia")
        statusItem.button?.image?.isTemplate = true
        statusItem.button?.toolTip = "Qoopia"
        let tray = NSMenu()
        tray.addItem(withTitle: text("Open Qoopia", "Открыть Qoopia"), action: #selector(showWindow), keyEquivalent: "").target = self
        tray.addItem(withTitle: text("Open in Browser", "Открыть в браузере"), action: #selector(openInBrowser), keyEquivalent: "").target = self
        tray.addItem(withTitle: text("Check for Updates…", "Проверить обновления…"), action: #selector(checkUpdates), keyEquivalent: "").target = self
        loginItem = tray.addItem(withTitle: text("Open at Login", "Запускать при входе"), action: #selector(toggleLogin), keyEquivalent: ""); loginItem.target = self
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        tray.addItem(.separator()); tray.addItem(withTitle: text("Quit Qoopia", "Выйти из Qoopia"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = tray
        createWindow(); showWindow()
        #if canImport(Sparkle)
        if Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") != nil {
            updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        }
        #endif
        if !connecting { openWorkspace() }
    }
    func createWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Qoopia"; window.minSize = NSSize(width: 720, height: 520); window.isReleasedWhenClosed = false; window.delegate = self
        window.setFrameAutosaveName("QoopiaWorkspace"); window.center()
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        webView = WKWebView(frame: .zero, configuration: configuration); webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!; content.addSubview(webView)
        NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: content.leadingAnchor), webView.trailingAnchor.constraint(equalTo: content.trailingAnchor), webView.topAnchor.constraint(equalTo: content.topAnchor), webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)])
        statusLabel = NSTextField(wrappingLabelWithString: text("Starting Qoopia…", "Запускаем Qoopia…")); statusLabel.alignment = .center; statusLabel.translatesAutoresizingMaskIntoConstraints = false
        progress = NSProgressIndicator(); progress.style = .spinning; progress.translatesAutoresizingMaskIntoConstraints = false; progress.startAnimation(nil)
        content.addSubview(statusLabel); content.addSubview(progress)
        NSLayoutConstraint.activate([statusLabel.centerXAnchor.constraint(equalTo: content.centerXAnchor), statusLabel.centerYAnchor.constraint(equalTo: content.centerYAnchor), statusLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 560), progress.centerXAnchor.constraint(equalTo: content.centerXAnchor), progress.bottomAnchor.constraint(equalTo: statusLabel.topAnchor, constant: -18)])
    }
    @objc func showWindow() {
        guard window != nil else { return }
        NSApp.setActivationPolicy(.regular); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); NSApp.setActivationPolicy(.accessory); return false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    @objc func openInBrowser() { if let url = workspaceURL { NSWorkspace.shared.open(url) } }
    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
            loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
            if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch { presentError(text("Could not change login settings", "Не удалось изменить автозапуск")) }
    }
    @objc func checkUpdates() {
        #if canImport(Sparkle)
        if let updater = updater { updater.checkForUpdates(nil); return }
        #endif
        presentError(text("Updates are available in signed release builds.", "Проверка обновлений доступна в подписанной версии приложения."))
    }
    func presentError(_ message: String) {
        guard !shuttingDown else { return }; statusItem.button?.toolTip = message; showWindow(); progress.stopAnimation(nil); progress.isHidden = true; statusLabel.isHidden = false; statusLabel.stringValue = message
        let alert = NSAlert(); alert.messageText = message
        alert.informativeText = text("Your saved data is preserved. Close older copies of Qoopia and try again.", "Ваши данные сохранены. Закройте старые копии Qoopia и повторите попытку.")
        alert.addButton(withTitle: text("Retry", "Повторить")); alert.addButton(withTitle: text("Later", "Позже"))
        alert.beginSheetModal(for: window) { response in if response == .alertFirstButtonReturn { self.openWorkspace() } }
    }
    func openWorkspace() {
        if child?.isRunning == true || preparing?.isRunning == true { showWindow(); return }
        statusLabel.stringValue = text("Preparing your workspace…", "Подготавливаем ваше пространство…"); statusLabel.isHidden = false; progress.isHidden = false; progress.startAnimation(nil)
        let process = Process(), pipe = Pipe(); process.executableURL = executable; process.arguments = ["desktop-prepare", "--commit"]; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice; preparing = process
        process.terminationHandler = { done in
            let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                self.preparing = nil; guard !self.shuttingDown else { return }
                guard done.terminationStatus == 0, let result = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any], let binary = result["binary"] as? String, binary.hasPrefix("/") else {
                    self.presentError(self.text("Qoopia could not prepare this update", "Не удалось подготовить обновление Qoopia")); return
                }
                self.startWorkspace(URL(fileURLWithPath: binary))
            }
        }
        do { try process.run() } catch { preparing = nil; presentError(text("Qoopia could not start", "Не удалось запустить Qoopia")) }
    }
    func startWorkspace(_ binary: URL) {
        let process = Process(), pipe = Pipe(); process.executableURL = binary; process.arguments = ["open", "--desktop"]
        var environment = ProcessInfo.processInfo.environment; environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; process.environment = environment
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice; child = process; outputBuffer = ""
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let bytes = handle.availableData; guard !bytes.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self.consume(String(decoding: bytes, as: UTF8.self)) }
        }
        process.terminationHandler = { done in DispatchQueue.main.async {
            if self.shuttingDown { return }
            if done.terminationStatus != 0 { self.presentError(self.text("Qoopia stopped unexpectedly", "Qoopia неожиданно остановилась")) }
        } }
        do { try process.run() } catch { child = nil; presentError(text("Qoopia could not start", "Не удалось запустить Qoopia")) }
    }
    func consume(_ chunk: String) {
        outputBuffer += chunk
        while let newline = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[..<newline]); outputBuffer.removeSubrange(...newline)
            guard let bytes = line.data(using: .utf8), let event = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any], event["event"] as? String == "workspace", let raw = event["url"] as? String, let url = URL(string: raw), allowedWorkspace(url) else { continue }
            var clean = URLComponents(url: url, resolvingAgainstBaseURL: false)!; clean.fragment = nil; workspaceURL = clean.url
            webView.load(URLRequest(url: url)); statusItem.button?.toolTip = text("Qoopia is running", "Qoopia работает")
        }
        if outputBuffer.utf8.count > 262144 { outputBuffer = "" }
    }
    func allowedWorkspace(_ url: URL) -> Bool { url.user == nil && url.password == nil && (url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(url.host ?? ""))) }
    func sameWorkspace(_ url: URL) -> Bool { guard let base = workspaceURL else { return false }; return url.scheme == base.scheme && url.host == base.host && url.port == base.port }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if sameWorkspace(url) || url.scheme == "blob" { decisionHandler(.allow); return }
        if ["https", "http", "mailto", "tg"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https", "http", "mailto", "tg"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; return nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { statusLabel.isHidden = true; progress.stopAnimation(nil); progress.isHidden = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { statusLabel.isHidden = false; statusLabel.stringValue = text("Connection interrupted. Reopen Qoopia to retry.", "Соединение прервано. Откройте Qoopia повторно."); progress.stopAnimation(nil) } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) { decisionHandler(response.canShowMIMEType && (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.hasPrefix("attachment") != true ? .allow : .download) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) { let panel = NSSavePanel(); panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent; panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.url : nil) } }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) { let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories; panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) } }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK"); alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: text("Cancel", "Отмена")); alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); if !connecting { if let url = workspaceURL { webView.load(URLRequest(url: url)) } else { openWorkspace() } }; return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if shuttingDown { return .terminateNow }
        if preparing?.isRunning == true { showWindow(); statusLabel.stringValue = text("Finishing workspace preparation. Please wait before quitting.", "Завершаем подготовку пространства. Дождитесь завершения перед выходом."); return .terminateCancel }
        let finish = { self.shuttingDown = true; if let auth = self.clientAuth, auth.isRunning { auth.terminate() }; if let process = self.child, process.isRunning { process.terminate(); DispatchQueue.global().async { process.waitUntilExit(); DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) } } } else { NSApp.reply(toApplicationShouldTerminate: true) } }
        if workspaceURL == nil { DispatchQueue.main.async(execute: finish); return .terminateLater }
        webView.callAsyncJavaScript("return await Promise.all(['/api/dashboard/my-agent','/api/dashboard/memory'].map(p=>fetch(p,{signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():Promise.reject()))).then(([a,m])=>Boolean(a.active_conversation||a.login||a.operation?.state==='running'||m.busy)).catch(()=>true)", arguments: [:], in: nil, in: .page) { result in
            if case .success(let value) = result, (value as? Bool) == false { finish(); return }
            let alert = NSAlert(); alert.messageText = self.text("Quit while work may be running?", "Выйти, пока работа может продолжаться?"); alert.informativeText = self.text("Closing the window keeps Qoopia running. Quitting stops its local agent.", "Закрытие окна оставляет Qoopia работать. Выход остановит локального агента."); alert.addButton(withTitle: self.text("Keep Running", "Продолжить работу")); alert.addButton(withTitle: self.text("Quit", "Выйти")); alert.beginSheetModal(for: self.window) { if $0 == .alertSecondButtonReturn { finish() } else { NSApp.reply(toApplicationShouldTerminate: false) } }
        }
        return .terminateLater
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        if connecting {
            let ru = Locale.preferredLanguages.first?.hasPrefix("ru") == true
            let alert = NSAlert()
            alert.messageText = ru ? "Завершите текущее подключение" : "Finish the current connection"
            alert.informativeText = ru ? "Завершите подтверждение в браузере или выйдите из Qoopia, затем откройте файл снова." : "Finish consent in your browser or quit Qoopia, then open the file again."
            alert.runModal()
            sender.reply(toOpenOrPrint: .failure)
            return
        }
        if filenames.count == 1 && filenames[0].hasSuffix(".qoopia-connection") {
            connecting = true
            configureClient(filenames[0], sender: sender, apply: false)
            return
        }
        guard filenames.count == 1, filenames[0].hasSuffix(".qoopia-memory") else {
            sender.reply(toOpenOrPrint: .failure); return
        }
        connecting = true
        let process = Process()
        process.executableURL = executable
        process.arguments = ["memory-link", "--file", filenames[0]]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { done in
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = done.terminationStatus == 0 ? "Connection configured" : "Connection could not be installed"
                let result = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
                alert.informativeText = result?["next"] as? String ?? "Open your selected Qoopia workspace and download its connection file again. Existing connections were preserved."
                alert.runModal()
                self.connecting = false
                sender.reply(toOpenOrPrint: done.terminationStatus == 0 ? .success : .failure)
                self.finishConnection()
            }
        }
        do { try process.run() } catch { connecting = false; sender.reply(toOpenOrPrint: .failure) }
    }

    func finishConnection() {
        showWindow()
        if workspaceURL == nil {
            progress.stopAnimation(nil); progress.isHidden = true
            statusLabel.stringValue = text("Connection setup finished. Continue in your selected client. You can quit Qoopia when finished.", "Настройка подключения завершена. Продолжите в выбранном клиенте. После завершения можно выйти из Qoopia.")
        }
    }

    func configureClient(_ file: String, sender: NSApplication, apply: Bool, approval: String = "") {
        let ru = Locale.preferredLanguages.first?.hasPrefix("ru") == true
        let process = Process()
        process.executableURL = executable
        process.arguments = ["client-link", "--file", file] + (apply ? ["--commit", "--approve", approval] : [])
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { done in
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                let result = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
                if apply && done.terminationStatus == 0 && result?["client"] as? String == "claude_desktop", let binding = result?["binding_file"] as? String {
                    self.authorizeDesktopConnection(binding, sender: sender)
                    return
                }
                if !apply && done.terminationStatus == 0 && result?["can_apply"] as? Bool == true {
                    let alert = NSAlert()
                    alert.messageText = ru ? "Добавить подключение Qoopia?" : "Add this Qoopia connection?"
                    alert.informativeText = "\(result?["client"] as? String ?? "")\n\(result?["mcp_url"] as? String ?? "")\n\n" + (ru ? "Затем откроется подтверждение доступа в браузере или клиенте. Остальные подключения сохранятся." : "Next, approve access in your browser or client. Your other connections will be preserved.")
                    alert.addButton(withTitle: ru ? "Добавить" : "Add")
                    alert.addButton(withTitle: ru ? "Отмена" : "Cancel")
                    if alert.runModal() == .alertFirstButtonReturn {
                        self.configureClient(file, sender: sender, apply: true, approval: result?["plan_digest"] as? String ?? "")
                        return
                    }
                } else {
                    let alert = NSAlert()
                    alert.messageText = done.terminationStatus == 0 && apply ? (ru ? "Адрес добавлен" : "Address added") : (ru ? "Проверьте настройки клиента" : "Review client settings")
                    alert.informativeText = done.terminationStatus == 0 && apply ? (ru ? "Откройте клиент, подтвердите подключение Qoopia и выполните запрос проверки из мастера. Подключение ещё не проверено." : "Open your client, authenticate its Qoopia connection, then run the wizard’s verification prompt. The connection is not verified yet.") : (ru ? "Не удалось добавить адрес. Откройте мастер подключений Qoopia и проверьте существующие настройки клиента." : "The address could not be added. Open the Qoopia connection wizard and review your existing client settings.")
                    alert.runModal()
                }
                self.connecting = false
                sender.reply(toOpenOrPrint: done.terminationStatus == 0 ? .success : .failure)
                self.finishConnection()
            }
        }
        do { try process.run() } catch { connecting = false; sender.reply(toOpenOrPrint: .failure) }
    }

    func authorizeDesktopConnection(_ file: String, sender: NSApplication) {
        let ru = Locale.preferredLanguages.first?.hasPrefix("ru") == true
        let process = Process()
        process.executableURL = executable
        process.arguments = ["client-auth", "--file", file, "--commit", "--open"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        clientAuth = process
        process.terminationHandler = { done in
            DispatchQueue.main.async {
                self.clientAuth = nil
                let alert = NSAlert()
                alert.messageText = done.terminationStatus == 0 ? (ru ? "Доступ подтверждён" : "Access approved") : (ru ? "Вход не завершён" : "Sign-in incomplete")
                alert.informativeText = done.terminationStatus == 0 ? (ru ? "Перезапустите Claude Desktop и выполните запрос проверки из мастера Qoopia. Подключение ещё не проверено." : "Restart Claude Desktop and run the verification prompt from the Qoopia wizard. The connection is not verified yet.") : (ru ? "Адаптер добавлен. Откройте файл подключения снова, чтобы повторить подтверждение доступа в браузере." : "The adapter is added. Open the connection file again to retry consent in your browser.")
                alert.runModal()
                self.connecting = false
                self.finishConnection()
            }
        }
        do { try process.run(); sender.reply(toOpenOrPrint: .success) }
        catch { clientAuth = nil; connecting = false; sender.reply(toOpenOrPrint: .failure) }
    }

}
let app = NSApplication.shared
let launcher = Launcher()
app.delegate = launcher
app.setActivationPolicy(.regular)
app.run()
