import AppKit

// The desktop app owns a foreground server only when no installed service is running.
final class Launcher: NSObject, NSApplicationDelegate {
    var child: Process?
    var clientAuth: Process?
    var connecting = false
    let executable = Bundle.main.resourceURL!.appendingPathComponent("bundle/qoopia")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let item = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Qoopia", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        menu.addItem(item)
        NSApp.mainMenu = menu
        // File-open setup can run without creating a second local workspace.
        if !connecting { openWorkspace() }
    }

    func openWorkspace() {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["open"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        let primary = child == nil
        if primary { child = process }
        process.terminationHandler = { finished in
            DispatchQueue.main.async {
                if finished.terminationStatus != 0 {
                    let alert = NSAlert()
                    alert.messageText = "Qoopia could not open"
                    alert.informativeText = "Your saved data is unchanged. Try opening Qoopia again. Diagnostic logs are in ~/Library/Logs/Qoopia."
                    alert.runModal()
                }
                if primary && !self.connecting { NSApp.terminate(nil) }
            }
        }
        do { try process.run() }
        catch {
            let alert = NSAlert(error: error)
            alert.runModal()
            if primary && !self.connecting { NSApp.terminate(nil) }
        }
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
                if self.child?.isRunning != true { NSApp.terminate(nil) }
            }
        }
        do { try process.run() } catch { connecting = false; sender.reply(toOpenOrPrint: .failure) }
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
                if self.child?.isRunning != true { NSApp.terminate(nil) }
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
                if self.child?.isRunning != true { NSApp.terminate(nil) }
            }
        }
        do { try process.run(); sender.reply(toOpenOrPrint: .success) }
        catch { clientAuth = nil; connecting = false; sender.reply(toOpenOrPrint: .failure) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !connecting { openWorkspace() }
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let process = clientAuth, process.isRunning { process.terminate() }
        if let process = child, process.isRunning { process.terminate() }
    }
}

let app = NSApplication.shared
let launcher = Launcher()
app.delegate = launcher
app.setActivationPolicy(.regular)
app.run()
