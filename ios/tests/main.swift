import Foundation

func reject(_ input: String) { precondition((try? Workspace(input)) == nil, "Accepted unsafe workspace: \(input)") }

for address in ["http://workspace.example", "https://user:secret@workspace.example", "https://workspace.example/dashboard?token=secret", "https://workspace.example/mcp", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://auth.qoopia.ai", "https://qoopia.ai", "https://c-example.qoopia.ai", "javascript:alert(1)", "https://workspace.example/#secret"] { reject(address) }
let workspace = try Workspace(" https://WORKSPACE.example:443/dashboard ")
precondition(workspace.origin.absoluteString == "https://workspace.example")
precondition(workspace.contains(URL(string: "https://workspace.example/api/dashboard/files/1")!))
precondition(!workspace.contains(URL(string: "https://workspace.example.evil.test/dashboard")!))
precondition(!workspace.contains(URL(string: "https://workspace.example:444/dashboard")!))
precondition(!workspace.contains(URL(string: "http://workspace.example/dashboard")!))
precondition(URLPolicy.workspaceLink(URL(string: "https://workspace.example/dashboard?install=1")!) == workspace)
precondition(URLPolicy.workspaceLink(URL(string: "https://workspace.example/dashboard?token=secret")!) == nil)
precondition(URLPolicy.workspaceLink(URLPolicy.account) == nil)
precondition(!URLPolicy.safeExternal(URL(string: "file:///private/data")!))
precondition(!URLPolicy.safeExternal(URL(string: "http://workspace.example")!))
precondition(URLPolicy.safeExternal(URL(string: "https://claude.ai/oauth")!))
print("iOS workspace URL policy: passed")

precondition(URLPolicy.accountWorkspace(URL(string: "https://workspace.example/dashboard?signin=account")!, from: URLPolicy.account) == workspace)
precondition(URLPolicy.accountWorkspace(URL(string: "https://workspace.example/dashboard?signin=account")!, from: URL(string: "https://evil.test")) == nil)
precondition(URLPolicy.accountWorkspace(URL(string: "https://workspace.example/dashboard?signin=account&token=secret")!, from: URLPolicy.account) == nil)
precondition(URLPolicy.accountWorkspace(URL(string: "https://localhost/dashboard?signin=account")!, from: URLPolicy.account) == nil)
