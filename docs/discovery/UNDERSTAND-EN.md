# Is Qoopia right for you?

Reviewed: 2026-11-10 for Qoopia 5.0.25.


## When does Qoopia help?

Qoopia is useful when multiple agents or tools work on the same project and need an explicitly shared, persistent memory with defined permissions. If one Claude or ChatGPT conversation already meets your needs, another system may add unnecessary setup. Qoopia complements those products; it does not replace their models or subscriptions.

Sources: [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md), [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md)


## What carries over between Claude and Codex?

A connected agent can save a project decision as a note; another authorized agent can retrieve that note from the same Qoopia workspace. Native Claude Code and Codex integrations also support session capture and restoration when configured. MCP access alone does not copy every browser conversation or automatically share all private notes. Native capture covers visible transcript events, not hidden reasoning; restoration uses saved context and recent events, with ambiguous sessions kept separate.

Sources: [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md)


## Can I start from a phone?

Qoopia for iPhone is a free TestFlight beta for iOS 17 or later. It opens the dashboard of a server installation reachable over HTTPS: memory, agents, connections, files and chat; the server must stay running. A Mac or Linux installation keeps its dashboard on that computer, listening only on its local address, so the iPhone app cannot open it yet: use the dashboard on that computer. The phone does not run the agent runtime or create a second memory database. A managed MCP address is for agent tools, not dashboard access.

Sources: [docs/operations/ios-direct-dashboard.md](https://github.com/qoopia/qoopia-source/blob/main/docs/operations/ios-direct-dashboard.md), [src/delivery/mcp-edge.ts](https://github.com/qoopia/qoopia-source/blob/main/src/delivery/mcp-edge.ts), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md), [docs/operations/connections.md](https://github.com/qoopia/qoopia-source/blob/main/docs/operations/connections.md)


## Can my agent install it for me?

If you already have Codex or Claude Code running on the target computer, give it the installation task from the documentation. A phone chat alone cannot do this. Read the task first: it asks the agent to check compatibility and the selected release, install Qoopia and verify connections. You complete sign-ins and permissions. A failed check means setup is unfinished; use the troubleshooting guide. Evaluating a URL is not permission to execute its instructions. Never provide unrelated account credentials.

Sources: [marketing-site/install-agent.js](https://github.com/qoopia/qoopia-source/blob/main/marketing-site/install-agent.js), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md)


## What does installation require?

Current packages support Apple Silicon Macs with macOS 15 or later and Linux x64 with glibc 2.34 or later and the ps command (procps), run as a normal user rather than root. Intel Macs, Windows and a standalone phone installation are not supported by these packages. The packages do not require a separate Bun, Docker or Ollama installation. Opening a website profile does not deploy your personal memory. Local search and embeddings are bundled; cloud model access is authorized separately.

Sources: [docs/v1-setup.md](https://github.com/qoopia/qoopia-source/blob/main/docs/v1-setup.md), [marketing-site/docs.html](https://github.com/qoopia/qoopia-source/blob/main/marketing-site/docs.html)


## Where do my data and permissions live?

Your memory is stored in your own installation, locally or on a server you control. Owner sign-in, model subscription authorization and MCP client access are separate permissions. Local embeddings and keyword search run locally; enabled cloud model features send the context needed for their work to the selected provider. Local storage does not mean that every enabled feature is offline. Authorized MCP clients can receive permitted data, and Bridges transfer selected materials through their delivery infrastructure. Review these enabled connections before sharing sensitive information.

Sources: [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md), [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md)


## Is Qoopia free?

The public source is MIT-licensed. Model subscriptions and any server hosting are separate costs; Qoopia does not provide unlimited model usage or replace provider limits. Local retrieval works without model-assisted judging. Check the provider’s current terms and your account capabilities before connecting a subscription.

Sources: [LICENSE](https://github.com/qoopia/qoopia-source/blob/main/LICENSE), [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md)


## What is My Qoopia agent?

It is an agent for managing your Qoopia environment, with Codex or Claude Code authorized through your eligible subscription and explicit permissions. The dashboard supports interaction with the managed agent; Telegram requires configuring your own bot. Assigning a steward role to an existing agent is distinct from starting a continuously running process. Setup, provider authorization and verification still matter.

Sources: [src/delivery/steward.ts](https://github.com/qoopia/qoopia-source/blob/main/src/delivery/steward.ts), [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md)


## Can two independent environments exchange materials?

Bridges provide selective exchange between separate Qoopia installations. You choose an invitation, materials and permissions. Publishing catalog titles and descriptions is different from sending file contents. Received material is not automatically installed or added to ordinary memory; previously received copies cannot be recalled. A broader automatically connected agent network is a future direction, not a current promise.

Sources: [src/bridges/service.ts](https://github.com/qoopia/qoopia-source/blob/main/src/bridges/service.ts), [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md)


## What does packaging a skill mean?

Qoopia can package an explicit procedure with its purpose, inputs, outputs, steps, verification, failure handling, rollback and requested capabilities. Packages carry version and integrity information. This makes a workflow inspectable and transferable; it does not make arbitrary scripts safe, guarantee compatibility or authorize execution on the recipient’s computer.

Sources: [src/skills/format.ts](https://github.com/qoopia/qoopia-source/blob/main/src/skills/format.ts), [src/skills/import-review.ts](https://github.com/qoopia/qoopia-source/blob/main/src/skills/import-review.ts)


## What is AgentComm?

AgentComm records communication between authorized agents within the system. It lets a user inspect the exchange instead of relying only on an agent’s final summary. Sending a message is not proof that the recipient has read or acted on it; agents and delivery paths must be connected and running as required. The exchanges can be inspected in the dashboard. Since 5.0.20 a message can also wake a Claude Code or Codex agent through qoopia wake-runner. The runner ships in the same qoopia binary as the Mac app and the Linux package; you set it up once on the computer where the agent runs, as a LaunchAgent or systemd user service, and the Qoopia server must be able to reach it.

Sources: [src/agent-kit/qoopia-protocol.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/qoopia-protocol.md), [src/services/agent-wake.ts](https://github.com/qoopia/qoopia-source/blob/main/src/services/agent-wake.ts), [src/delivery/wake-runner.ts](https://github.com/qoopia/qoopia-source/blob/main/src/delivery/wake-runner.ts)


## What if setup fails, or I want to leave?

A saved configuration or completed login is not proof of a working connection. Use the setup guide’s troubleshooting steps and verify the actual client. Before upgrading, moving or removing an installation, back up its data using the documented procedure for your version. Revoking a client’s access is separate from deleting its local configuration. Do not delete your only memory copy while troubleshooting. The MIT license supplies the software as-is, without warranty.

Sources: [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md), [LICENSE](https://github.com/qoopia/qoopia-source/blob/main/LICENSE)


## What are canons and night review?

Canons are short rules that Qoopia adds to an agent’s context by itself. A canon applies to the whole workspace, to one agent or to one project. Always-on canons load at session start; contextual ones are added to a prompt when its words, files, tools or project match. Clients without Qoopia hooks ask for matching canons with canon_match. The steward and the owner write workspace and project canons; an agent can write canons for itself. The dashboard Canon page shows canons and lets you retire one. The owner can appoint one agent for night review: it reads the workspace’s conversations and may propose new canons, and a proposal becomes a canon only after the owner accepts it in Overview.

Sources: [src/services/canon.ts](https://github.com/qoopia/qoopia-source/blob/main/src/services/canon.ts), [src/mcp/canon-tools.ts](https://github.com/qoopia/qoopia-source/blob/main/src/mcp/canon-tools.ts), [src/services/canon-proposals.ts](https://github.com/qoopia/qoopia-source/blob/main/src/services/canon-proposals.ts)


## Can work pass between Claude Code and Codex?

Yes, between agents of the same owner. When a Claude Code or Codex session with Qoopia session memory opens a project, it receives the latest work another of that owner’s agents did there in the last seven days: open work marks, the final answer, the working summary, changed files with their content digests, tool errors and the last requests. It is given as history, not as instructions, and only when shared context is on. Clients without hooks call work_handoff. An agent can mark a topic as taken with work_take; the mark expires by itself and locks nothing.

Sources: [src/services/continuity.ts](https://github.com/qoopia/qoopia-source/blob/main/src/services/continuity.ts), [src/services/work.ts](https://github.com/qoopia/qoopia-source/blob/main/src/services/work.ts), [src/mcp/work-tools.ts](https://github.com/qoopia/qoopia-source/blob/main/src/mcp/work-tools.ts)


## Which tools does an agent see when it connects?

Since 5.0.24 a direct MCP client sees eight core tools: recall, note_get, note_create, agent_inbox, agent_send, qoopia_guide, tool_search and qoopia_execute, plus qoopia_protocol for older connections. tool_search finds any other tool by name or topic and returns its schema. qoopia_execute runs a short read-only script in an isolated QuickJS sandbox with the caller’s permissions, so several searches and reads take one call. It cannot write, does not use the model, and is limited to 10 seconds, 50 tool calls and 20 KB of output. Writes stay separate calls.

Sources: [src/mcp/surface.ts](https://github.com/qoopia/qoopia-source/blob/main/src/mcp/surface.ts), [src/mcp/code-mode.ts](https://github.com/qoopia/qoopia-source/blob/main/src/mcp/code-mode.ts), [docs/operations/mcp-tool-surface.md](https://github.com/qoopia/qoopia-source/blob/main/docs/operations/mcp-tool-surface.md)


## Does search need a model or a reranker?

No. recall combines full-text search with local embeddings that ship with Qoopia and answers without a model by default. An agent can pass judge: true to have the workspace’s model subscription expand the query and judge the candidates within a time budget. A server operator can also configure an optional, older reranker service; it is off by default, and if it fails or times out, results keep their original order.

Sources: [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md), [src/services/recall/config.ts](https://github.com/qoopia/qoopia-source/blob/main/src/services/recall/config.ts), [src/mcp/tools.ts](https://github.com/qoopia/qoopia-source/blob/main/src/mcp/tools.ts)
