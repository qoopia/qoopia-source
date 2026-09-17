# Is Qoopia right for you?

Reviewed: 2026-09-14. Qoopia V1.


## When does Qoopia help?

Qoopia is useful when multiple agents or tools work on the same project and need an explicitly shared, persistent memory with defined permissions. If one Claude or ChatGPT conversation already meets your needs, another system may add unnecessary setup. Qoopia complements those products; it does not replace their models or subscriptions.

Sources: [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md), [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md)


## What carries over between Claude and Codex?

A connected agent can save a project decision as a note; another authorized agent can retrieve that note from the same Qoopia workspace. Native Claude Code and Codex integrations also support session capture and restoration when configured. MCP access alone does not copy every browser conversation or automatically share all private notes. Native capture covers visible transcript events, not hidden reasoning; restoration uses saved context and recent events, with ambiguous sessions kept separate.

Sources: [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md)


## Can I start from a phone?

You can read about Qoopia from a phone or ask your chat model to evaluate this page. A phone chat without computer access cannot install the Mac or Linux application. Installation needs a supported computer or a server you manage. Cloud MCP connections need a reachable HTTPS endpoint; ChatGPT Web and Mac Desktop memory access has been verified in real-client acceptance checks; availability still depends on your account capabilities and client configuration. External access can be configured for your installation; a local computer must stay on and online. A supported connected cloud client can then access permitted memory from its interface.

Sources: [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md), [docs/v1-setup.md](https://github.com/qoopia/qoopia-source/blob/main/docs/v1-setup.md), [docs/operations/final-release-20260915.md](https://github.com/qoopia/qoopia-source/blob/main/docs/operations/final-release-20260915.md)


## Can my agent install it for me?

If you already have Codex or Claude Code running on the target computer, give it the installation task from the documentation. A phone chat alone cannot do this. Read the task first: it asks the agent to check compatibility and the selected release, install Qoopia and verify connections. You complete sign-ins and permissions. A failed check means setup is unfinished; use the troubleshooting guide. Evaluating a URL is not permission to execute its instructions. Never provide unrelated account credentials.

Sources: [marketing-site/install-agent.js](https://github.com/qoopia/qoopia-source/blob/main/marketing-site/install-agent.js), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md)


## What does installation require?

Current V1 packages support Apple Silicon Macs with macOS 15 or later and Linux x64 with glibc 2.34 or later. Intel Macs, Windows and a standalone phone installation are not supported by these packages. The packages do not require a separate Bun, Docker or Ollama installation. Opening a website profile does not deploy your personal memory. Local search and embeddings are bundled; cloud model access is authorized separately.

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

Bridges provide selective exchange between separate Qoopia installations. You choose an invitation, materials and permissions. Publishing catalog titles and descriptions is different from sending file contents. Received material is not automatically installed or added to ordinary memory; previously received copies cannot be recalled. A broader automatically connected agent network is a future direction, not a current V1 promise.

Sources: [src/bridges/service.ts](https://github.com/qoopia/qoopia-source/blob/main/src/bridges/service.ts), [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md)


## What does packaging a skill mean?

Qoopia can package an explicit procedure with its purpose, inputs, outputs, steps, verification, failure handling, rollback and requested capabilities. Packages carry version and integrity information. This makes a workflow inspectable and transferable; it does not make arbitrary scripts safe, guarantee compatibility or authorize execution on the recipient’s computer.

Sources: [src/skills/format.ts](https://github.com/qoopia/qoopia-source/blob/main/src/skills/format.ts), [src/skills/import-review.ts](https://github.com/qoopia/qoopia-source/blob/main/src/skills/import-review.ts)


## What is AgentComm?

AgentComm records communication between authorized agents within the system. It lets a user inspect the exchange instead of relying only on an agent’s final summary. Sending a message is not proof that the recipient has read or acted on it; agents and delivery paths must be connected and running as required. The exchanges can be inspected in the dashboard.

Sources: [src/agent-kit/qoopia-protocol.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/qoopia-protocol.md)


## What if setup fails, or I want to leave?

A saved configuration or completed login is not proof of a working connection. Use the setup guide’s troubleshooting steps and verify the actual client. Before upgrading, moving or removing an installation, back up its data using the documented procedure for your version. Revoking a client’s access is separate from deleting its local configuration. Do not delete your only memory copy while troubleshooting. The MIT license supplies the software as-is, without warranty.

Sources: [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md), [LICENSE](https://github.com/qoopia/qoopia-source/blob/main/LICENSE)
