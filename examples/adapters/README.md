# Qoopia V4 native MCP adapters

Use each host's native remote-MCP configuration. Keep the endpoint and bearer
token in the host's secret/environment facility; never paste them into an
adapter file or commit them. The same canonical tool names and schemas apply to
Codex, Claude Code, Gemini CLI, Ductor, OpenClaw, and Hermes.

1. Copy `native-mcp.example.json` into the host-specific MCP configuration.
2. Substitute the endpoint from `QOOPIA_MCP_URL` and inject the bearer value
   from `QOOPIA_MCP_TOKEN` at runtime.
3. Start with the memory/read-only profile. Enable write tools only for an
   authorized agent and canonical instance.
4. Run `qoopia v4-contract`, then the host's MCP tool-list command.

Deprecated compatibility aliases are intentionally omitted. The adapter does
not assign an owner, role, workspace, or endpoint; those remain deployment
configuration.
