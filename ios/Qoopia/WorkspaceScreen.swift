import SafariServices
import SwiftUI
import WebKit

struct WorkspaceScreen: View {
    @ObservedObject var browser: WorkspaceBrowser
    @State private var confirmSignOut = false
    @State private var dialogInput = ""
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if browser.loading { ProgressView(value: browser.progress).tint(.primary).accessibilityLabel(Text("Loading")) }
                if browser.offline {
                    Label("No connection. Reconnect and tap Reload.", systemImage: "wifi.slash")
                        .font(.footnote).frame(maxWidth: .infinity).padding(12)
                        .background(.thinMaterial).accessibilityAddTraits(.updatesFrequently)
                }
                ZStack {
                    WebWorkspace(webView: browser.webView)
                    if browser.failed {
                        ContentUnavailableView {
                            Label("Workspace unavailable", systemImage: "network")
                        } description: {
                            Text("Check that your computer or server is online and reachable from this iPhone. Your data stays there.")
                                .foregroundStyle(Color(uiColor: .label))
                        } actions: {
                            Button("Retry", action: browser.reload)
                                .buttonStyle(.borderedProminent)
                                .foregroundStyle(Color(uiColor: .systemBackground))
                            Button("Workspaces") { browser.showSettings = true }
                        }
                        .background(Color(uiColor: .systemBackground))
                    }
                }
            }
            .navigationTitle("Qoopia")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { browser.showSettings = true } label: { Image(systemName: "gearshape").frame(minWidth: 44, minHeight: 44) }
                        .accessibilityLabel(Text("App settings"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Account", systemImage: "person.crop.circle") { browser.open(nil) }
                        Button("Sign out on this iPhone", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmSignOut = true }
                        Link("Help", destination: URL(string: "https://qoopia.ai/mobile")!)
                    } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(Text("Options"))
                }

            }
            .toolbar(browser.isWorkspacePage ? .hidden : .visible, for: .navigationBar)
            .sheet(isPresented: $browser.showSettings) { WorkspacePicker(browser: browser) }
            .sheet(item: $browser.externalPage) { page in SafariPage(url: page.url).ignoresSafeArea() }
            .sheet(item: $browser.sharedFile, onDismiss: browser.clearSharedFile) { file in FileShare(url: file.url) }
            .confirmationDialog("Open this workspace?", isPresented: Binding(
                get: { browser.pendingWorkspace != nil },
                set: { if !$0 { browser.pendingWorkspace = nil } }
            ), titleVisibility: .visible) {
                if let workspace = browser.pendingWorkspace {
                    Button("Connect") { browser.add(workspace) }
                }
                Button("Cancel", role: .cancel) { browser.pendingWorkspace = nil }
            } message: { Text(browser.pendingWorkspace?.origin.absoluteString ?? "") }
            .alert("Sign out on this iPhone?", isPresented: $confirmSignOut) {
                Button("Cancel", role: .cancel) {}
                Button("Sign out", role: .destructive) { Task { await browser.clearSessions() } }
            } message: { Text("This clears account and workspace sessions on this iPhone. It does not delete your account, agents or memory.") }
            .alert("Download failed", isPresented: $browser.downloadFailed) {
                Button("OK", role: .cancel) {}
            } message: { Text("Return to the file and try again. Your original file stays in Qoopia.") }
            .alert(browser.active?.name ?? "Qoopia", isPresented: Binding(
                get: { browser.webDialog != nil },
                set: { if !$0 { browser.answerDialog(nil) } }
            )) {
                if browser.webDialog?.kind == .input { TextField("", text: $dialogInput) }
                if browser.webDialog?.kind != .message { Button("Cancel", role: .cancel) { browser.answerDialog(nil) } }
                Button("OK") { browser.answerDialog(browser.webDialog?.kind == .input ? dialogInput : "ok") }
            } message: { Text(browser.webDialog?.message ?? "") }
            .onChange(of: browser.webDialog?.id) { _, _ in dialogInput = browser.webDialog?.initial ?? "" }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { browser.resume() }
            }
            .onAppear {
                #if DEBUG
                browser.showSettings = ProcessInfo.processInfo.arguments.contains("--acceptance-workspaces")
                #endif
            }
        }
    }
}

private struct WorkspacePicker: View {
    @ObservedObject var browser: WorkspaceBrowser
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var invalid = false
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button { browser.open(nil); dismiss() } label: {
                        Label("Continue with your email", systemImage: "envelope")
                    }
                } footer: {
                    Text("Open the workspace saved in your Qoopia profile. Access is checked by your existing installation.")
                        .foregroundStyle(Color(uiColor: .label))
                }
                if !browser.workspaces.isEmpty {
                    Section("Saved workspaces") {
                        ForEach(browser.workspaces) { workspace in
                            Button { browser.open(workspace); dismiss() } label: {
                                HStack {
                                    Text(workspace.name).foregroundStyle(.primary)
                                    Spacer()
                                    if browser.active == workspace { Image(systemName: "checkmark") }
                                }
                            }.swipeActions { Button("Remove shortcut", role: .destructive) { browser.forget(workspace) } }
                        }
                    }
                }
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Workspace HTTPS address").font(.footnote)
                        TextField(text: $address, prompt: Text(verbatim: "https://your-server.example").foregroundColor(Color(uiColor: .label))) {
                            Text("Workspace HTTPS address")
                        }
                        .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel(Text("Workspace HTTPS address"))
                    }
                    if invalid { Text("Enter your dashboard HTTPS address, without tokens. Localhost and MCP-only addresses cannot open a workspace on iPhone.").font(.footnote) }
                    Button("Connect workspace") {
                        do { browser.add(try Workspace(address)); dismiss() }
                        catch { invalid = true }
                    }.disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: { Text("Use an address") }
                  footer: {
                    Text("Your computer or server must stay online. Use the email already linked to it. Qoopia does not create another copy of your memory here.")
                        .foregroundStyle(Color(uiColor: .label))
                  }
                if let workspace = browser.active {
                    Section {
                        Button("Reload") { browser.reload(); dismiss() }
                        ShareLink("Share workspace address", item: workspace.dashboard)
                    }
                }
                Section {
                    Button("Sign out on this iPhone", role: .destructive) { confirmSignOut = true }
                    Link("Privacy", destination: URL(string: "https://auth.qoopia.ai/privacy")!)
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                }
            }
            .alert("Sign out on this iPhone?", isPresented: $confirmSignOut) {
                Button("Cancel", role: .cancel) {}
                Button("Sign out", role: .destructive) { dismiss(); Task { await browser.clearSessions() } }
            } message: { Text("This clears account and workspace sessions on this iPhone. It does not delete your account, agents or memory.") }
            .navigationTitle("App settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct WebWorkspace: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

private struct SafariPage: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

private struct FileShare: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
