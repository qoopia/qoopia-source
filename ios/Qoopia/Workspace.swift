import Foundation

/// Only connection addresses belong in preferences. Cookies stay in WebKit's data store.
struct Workspace: Codable, Identifiable, Equatable {
    let origin: URL
    var id: String { origin.absoluteString }
    var name: String { origin.host ?? "Qoopia" }
    var dashboard: URL { origin.appendingPathComponent("dashboard") }

    init(_ address: String) throws {
        // "qoopia.ai." is qoopia.ai: the trailing root dot must not slip past the checks below.
        guard let parts = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host?.lowercased().replacingOccurrences(of: #"\.+$"#, with: "", options: .regularExpression),
              !host.isEmpty, parts.user == nil, parts.password == nil, !URLPolicy.loopback(host),
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

    /// Any spelling of this device: 2130706433, 0177.0.0.1, 0.0.0.0, ::1, ::ffff:127.0.0.1.
    static func loopback(_ host: String) -> Bool {
        var v4 = in_addr()
        if inet_aton(host, &v4) == 1 { let address = UInt32(bigEndian: v4.s_addr); return address >> 24 == 127 || address == 0 }
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), &v6) == 1 else { return false }
        let bytes = withUnsafeBytes(of: v6) { Array($0) }
        if bytes[0..<15].allSatisfy({ $0 == 0 }) { return bytes[15] <= 1 }
        return bytes[0..<10].allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff && (bytes[12] == 127 || bytes[12...15].allSatisfy({ $0 == 0 }))
    }

    static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme == "https" && rhs.scheme == "https" &&
        lhs.host?.lowercased() == rhs.host?.lowercased() &&
        (lhs.port ?? 443) == (rhs.port ?? 443) && rhs.user == nil && rhs.password == nil
    }

    /// A file the page builds itself (URL.createObjectURL) is a blob: URL whose origin is the inner URL.
    static func owner(_ url: URL) -> URL {
        url.scheme?.lowercased() == "blob" ? URL(string: String(url.absoluteString.dropFirst(5))) ?? url : url
    }

    static func workspaceLink(_ url: URL, from source: URL? = nil) -> Workspace? {
        // Strip only the known install hint from our profile. Never import a credential URL.
        // Any other site's home page (a link in a chat answer) opens in Safari, not as a workspace offer:
        // only the install hint or a link on the account page names a workspace.
        let fromAccount = source.map { sameOrigin(account, $0) } ?? false
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.query == "install=1" || parts.query == nil && fromAccount, parts.fragment == nil else { return nil }
        parts.query = nil
        return parts.url.flatMap { try? Workspace($0.absoluteString) }
    }

    static func safeExternal(_ url: URL) -> Bool {
        ["https", "mailto", "tg"].contains(url.scheme?.lowercased() ?? "") &&
        url.user == nil && url.password == nil
    }
}
