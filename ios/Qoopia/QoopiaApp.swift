import SwiftUI

@main
struct QoopiaApp: App {
    @StateObject private var browser = WorkspaceBrowser()

    var body: some Scene {
        WindowGroup {
            WorkspaceScreen(browser: browser)
                .tint(.primary)
        }
    }
}
