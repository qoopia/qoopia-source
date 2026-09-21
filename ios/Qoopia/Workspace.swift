import Foundation

/// Only connection addresses belong in preferences. Cookies stay in WebKit's data store.
struct Workspace: Codable, Identifiable, Equatable {
    let origin: URL
    var id: String { origin.absoluteString }
    var name: String { origin.host ?? "Qoopia" }
    var dashboard: URL { origin.appendingPathComponent("dashboard") }

    init(_ address: String) throws {
        guard let parts = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host?.lowercased(),
              !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              ["", "/", "/dashboard", "/dashboard/", "/local-login"].contains(parts.path),
              !["localhost", "localhost.", "0.0.0.0", "::1", "[::1]", "qoopia.ai", "www.qoopia.ai", "auth.qoopia.ai"].contains(host),
              !host.hasPrefix("127."), !host.hasSuffix(".localhost"),
              !(host.hasPrefix("c-") && host.hasSuffix(".qoopia.ai")) else {
            throw WorkspaceError.invalidAddress
        }
        var canonical = URLComponents()
        canonical.scheme = "https"
        canonical.host = host
        canonical.port = parts.port == 443 ? nil : parts.port
        guard let url = canonical.url else { throw WorkspaceError.invalidAddress }
        origin = url
    }

    func contains(_ url: URL) -> Bool { URLPolicy.sameOrigin(origin, url) }
}

enum WorkspaceError: Error { case invalidAddress }

enum URLPolicy {
    static let account = URL(string: "https://auth.qoopia.ai/profile?app=ios")!

    static func accountWorkspace(_ url: URL, from source: URL?) -> Workspace? {
        guard let source, sameOrigin(account, source),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.path == "/dashboard", parts.query == "signin=account", parts.fragment == nil else { return nil }
        parts.query = nil
        return parts.url.flatMap { try? Workspace($0.absoluteString) }
    }

    static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme == "https" && rhs.scheme == "https" &&
        lhs.host?.lowercased() == rhs.host?.lowercased() &&
        (lhs.port ?? 443) == (rhs.port ?? 443) && rhs.user == nil && rhs.password == nil
    }

    static func workspaceLink(_ url: URL) -> Workspace? {
        // Strip only the known install hint from our profile. Never import a credential URL.
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.query == nil || parts.query == "install=1", parts.fragment == nil else { return nil }
        parts.query = nil
        return parts.url.flatMap { try? Workspace($0.absoluteString) }
    }

    static func safeExternal(_ url: URL) -> Bool {
        ["https", "mailto", "tg"].contains(url.scheme?.lowercased() ?? "") &&
        url.user == nil && url.password == nil
    }
}
