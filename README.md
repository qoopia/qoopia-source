<p align="center">
  <img src="src/public/brand/qoopia-app-icon-1024.png" alt="Qoopia" width="96">
</p>

<h1 align="center">Qoopia</h1>
<p align="center">Memory your AI agents can share — under your control.</p>
<p align="center">
  <a href="https://qoopia.ai">Website</a> ·
  <a href="https://qoopia.ai/docs#agent-install">Install with an agent</a> ·
  <a href="https://github.com/qoopia/qoopia-downloads/releases/latest">Downloads</a> ·
  <a href="README.ru.md">Русский</a>
</p>

Qoopia gives your agents persistent memory across sessions and clients. Use your own local installation or server, connect agents through MCP, and keep working in the tools you already use.

## Is Qoopia right for you?

[Benefits, requirements and permissions](docs/discovery/UNDERSTAND-EN.md). A phone chat can evaluate Qoopia; installation requires an agent on a supported computer. Evaluating a link does not authorize executing its commands.

## What you can do

- Keep notes, files and session context accessible to your connected agents.
- See agents, their notes and AgentComm conversations in a dashboard.
- Choose Codex or Claude Code for **My Qoopia agent**, using your own eligible subscription. Chat in the dashboard or connect your own Telegram bot.
- Connect separate environments through controlled bridges. Choose what to publish and what to import.
- Turn approved work into reusable skill packages and share selected materials with other environments.

MCP access to memory and authorization to run a model are separate connections. Your agents do not gain access to somebody else's memory by registering on the website.

## Get started

**Already use Codex or Claude Code with access to your computer? Give it this task:**

```text
Install Qoopia on this computer using https://qoopia.ai/docs#agent-install.
Read the instructions fully, verify the official download, and create my own
memory. Ask me to complete sign-ins and approve access. Connect my chosen
client and verify it with an actual memory call before reporting success.
```

Or download the [signed installer](https://github.com/qoopia/qoopia-downloads/releases/latest), follow the included instructions, and open Qoopia. No developer checkout is needed.

| Platform | V1 support |
| --- | --- |
| macOS | Apple Silicon, macOS 15 or later |
| Linux | x64, glibc 2.34 or later; `procps` for process management |
| Windows / Intel Mac | Not included in this release |

ChatGPT Web/Desktop MCP connections are experimental. Managed HTTPS is a limited pilot; a complete real-account enrollment has not yet been qualified. A model subscription is subject to the provider's availability and limits. Telegram requires your own bot and a running, connected host.

## Your data and control

SQLite is the canonical store in the installation you select. Access is scoped and revocable. Bridges do not merge everyone's private memory. External model calls and browser connections can send authorized data outside your machine; self-hosting does not mean every operation stays offline. Managed HTTPS uses Cloudflare Tunnel and is not end-to-end encrypted through that intermediary.

## Explore the code

| Area | Location |
| --- | --- |
| Memory and MCP | [src](src) · [SDK](sdk) |
| Dashboard agent | [Guide](docs/operations/my-qoopia-agent.md) |
| Client connections | [Connection contract](docs/operations/connections.md) |
| Bridges | [Bridge design](docs/BRIDGES.md) |
| Database evolution | [migrations](migrations) |
| Tests | [tests](tests) |

This is the public source distribution of Qoopia V1. It starts with a clean history and excludes private operational records. [Source provenance](docs/SOURCE-PROVENANCE.md) records the original release revision and file checksums; published installers retain their existing signatures and release identifiers.

## Develop

Install Bun **1.3.11**, then:

```sh
git clone https://github.com/qoopia/qoopia-source.git
cd qoopia-source
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run test:storage-full
```

For a disposable development installation, choose an unused directory:

```sh
export QOOPIA_ROOT="$(mktemp -d)"
export QOOPIA_SERVER_ROLE=canonical
bun run migrate
bun run dev
```

The ordinary suite leaves one deliberate skip for the SQLite-full fault. `test:storage-full` runs it in a fresh temporary database; both commands are mandatory in CI. See the [storage-full check](docs/operations/storage-full-check.md).

Use synthetic data. Keep production credentials and personal memory out of tests. The schema-35 upgrade test includes a verified source-only fixture, so it does not need access to private Git history.

See [contribution guidelines](CONTRIBUTING.md) and [security reporting](SECURITY.md).

## License

[MIT](LICENSE). Bundled third-party components retain their own license notices in [scripts/vendor](scripts/vendor) and the brand asset directories.
