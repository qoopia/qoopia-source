import Foundation

func reject(_ input: String) { precondition((try? Workspace(input)) == nil, "Accepted unsafe workspace: \(input)") }

for address in ["https://qoopia.ai.", "https://auth.qoopia.ai.", "https://c-abc.qoopia.ai.", "https://2130706433", "https://0177.0.0.1", "https://0.0.0.0", "https://[::ffff:127.0.0.1]", "https://[::]", "http://workspace.example", "https://user:secret@workspace.example", "https://workspace.example/dashboard?token=secret", "https://workspace.example/mcp", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://auth.qoopia.ai", "https://qoopia.ai", "https://c-example.qoopia.ai", "javascript:alert(1)", "https://workspace.example/#secret"] { reject(address) }
let workspace = try Workspace(" https://WORKSPACE.example:443/dashboard ")
precondition(workspace.origin.absoluteString == "https://workspace.example")
precondition(workspace.contains(URL(string: "https://workspace.example/api/dashboard/files/1")!))
precondition(!workspace.contains(URL(string: "https://workspace.example.evil.test/dashboard")!))
precondition(!workspace.contains(URL(string: "https://workspace.example:444/dashboard")!))
precondition(!workspace.contains(URL(string: "http://workspace.example/dashboard")!))
precondition(URLPolicy.workspaceLink(URL(string: "https://workspace.example/dashboard?install=1")!) == workspace)
precondition(URLPolicy.workspaceLink(URL(string: "https://workspace.example/dashboard?token=secret")!) == nil)
precondition(URLPolicy.workspaceLink(URLPolicy.account) == nil)
// A plain link to another site's home page is not a workspace offer; on the account page it is.
precondition(URLPolicy.workspaceLink(URL(string: "https://github.com/")!) == nil)
precondition(URLPolicy.workspaceLink(URL(string: "https://workspace.example/dashboard")!, from: URL(string: "https://evil.test/")) == nil)
precondition(URLPolicy.workspaceLink(URL(string: "https://workspace.example/dashboard")!, from: URLPolicy.account) == workspace)
precondition(!URLPolicy.safeExternal(URL(string: "file:///private/data")!))
precondition(!URLPolicy.safeExternal(URL(string: "http://workspace.example")!))
precondition(URLPolicy.safeExternal(URL(string: "https://claude.ai/oauth")!))
// Connection, memory and bridge files are built in the page and downloaded from a blob: URL.
precondition(workspace.contains(URLPolicy.owner(URL(string: "blob:https://workspace.example/4f8a2c1e-0b7d-4a51-9c3e-1d2f3a4b5c6d")!)))
precondition(!workspace.contains(URLPolicy.owner(URL(string: "blob:https://evil.test/4f8a2c1e-0b7d-4a51-9c3e-1d2f3a4b5c6d")!)))
precondition(!workspace.contains(URLPolicy.owner(URL(string: "blob:null/4f8a2c1e")!)))
precondition(!workspace.contains(URL(string: "blob:https://workspace.example/4f8a2c1e")!))
precondition((try? Workspace("https://workspace.example.")) == workspace)
precondition((try? Workspace("https://10.0.0.5")) != nil)
print("iOS workspace URL policy: passed")

precondition(URLPolicy.accountWorkspace(URL(string: "https://workspace.example/dashboard?signin=account")!, from: URLPolicy.account) == workspace)
precondition(URLPolicy.accountWorkspace(URL(string: "https://workspace.example/dashboard?signin=account")!, from: URL(string: "https://evil.test")) == nil)
precondition(URLPolicy.accountWorkspace(URL(string: "https://workspace.example/dashboard?signin=account&token=secret")!, from: URLPolicy.account) == nil)
precondition(URLPolicy.accountWorkspace(URL(string: "https://localhost/dashboard?signin=account")!, from: URLPolicy.account) == nil)
