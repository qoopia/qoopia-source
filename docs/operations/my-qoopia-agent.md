# My Qoopia agent — dashboard and personal Telegram channel

The dashboard is the owner's place to inspect and control Qoopia. Its primary destinations are My Qoopia agent, Agents and their notes, Agent conversations, Bridges, and External folder. The existing black/white identity, IBM Plex Sans interface and Marck Script wordmark remain canonical; see ../CANONICAL-DESIGN.md.

## Supported execution

My Qoopia agent lets the owner choose ChatGPT / Codex (`codex`) or Claude / Claude Code (`claude_code`). Both run the pinned official native runtime on the installation's host with a dedicated private profile and the owner's steward identity. Codex uses its stdio app-server and a dedicated CODEX_HOME; Claude Code uses its own runtime and profile. Sign in with the selected provider and a subscription that includes that runtime; provider access and plan limits still apply. API-key billing is not selected automatically. Changing provider does not transfer the other provider's credentials or native conversation. Existing external clients remain available through normal connections.

Setup provisions the verified native runtime and starts it. A new steward has the no-destructive Qoopia tool profile. If the installation already has its native Codex memory-client binding to the current active steward, setup may reuse that identity and key. An unrelated steward is not silently replaced. Reusing the identity preserves its memory authority; it does not clone the external client's tools, skills, authentication, model settings or working directory. The first-run screen explains this distinction.

The Codex app-server uses on-request approvals and workspace-write sandboxing. Claude Code uses its own permission requests through the dedicated Claude runtime. The browser can invoke only the typed Qoopia actions, never arbitrary native RPC. Supported command, file-change, permission and question requests are bound to the current turn, expire after five minutes and can be answered once. Unknown requests are refused. Command approval is not a blanket permission to publish, send messages or change access.

## Conversations and results

The selected conversation is persisted per owner and shared by the dashboard and Telegram. Selecting a conversation or using /new changes that selection. Both channels resume its native thread; only one turn runs for an owner at a time. Concurrent messages are rejected with feedback rather than silently queued into another task. The browser retains a submitted draft when sending fails.

The newest 50 turns are loaded first. Earlier messages and older conversation pages remain reachable. Already loaded messages are retained as new turns arrive. Requests have stable idempotency keys; a server restart marks unfinished turns interrupted and never blindly repeats possibly executed work. User messages and completed answers also pass through the normal session storage, so they can be inspected from the agent's sessions. Native thread persistence and Qoopia memory indexing are distinct; the existing memory model configuration still controls automatic session summaries.

Regular files in the dedicated agent workspace are exposed as owner-authorized attachment downloads. The list is bounded to 100 files, four nested directory levels and 25 MiB per file. Hidden files, symlinks, hard links and paths outside this folder are refused. The download revalidates the opened file identity and size, forces an attachment and disables caching. Model text is escaped; arbitrary paths or markup in an answer do not become privileged links. Files elsewhere and memory objects remain accessible through the corresponding dashboard sections or existing native client.

Agent conversations (AgentComm) refresh every five seconds while open. New messages preserve the reader's position and expose a jump-to-latest action. Connection loss and recovery are visible. Search and Last 24 hours filter apply to the latest 100 conversation pairs returned by the existing API.

## Personal Telegram bot

First-run setup offers In Qoopia / Telegram. The Telegram path uses a dedicated bot created in BotFather. The owner enters its token in the dashboard password field. Tokens are stored only in the private local profile, never in the database, browser storage or application logs. Bots with an existing webhook or another local owner binding are refused.

A random, expiring Start link identifies a candidate private Telegram user. The dashboard owner must confirm that exact numeric user/chat pair. Messages from other people, groups and bots cannot run a task or retrieve this owner's memory. The primary navigation becomes Open my Qoopia agent in Telegram only after an actual completed model answer has been accepted by Telegram. Dashboard settings and chat remain available.

The bot supports text, /new and /stop. Simple command requests offer Allow/Decline inline; file patches, broader permissions and questions direct the owner to the full dashboard preview. Unstartable messages are acknowledged with feedback so that they cannot block later /stop messages. Delivery uses a durable ledger: an ambiguous send is marked uncertain, surfaced in the dashboard and never retried blindly. The full answer remains in the dashboard; Telegram messages exceeding its bounded response size link the user back by instruction. Files/voice messages are not supported in this initial channel.

Qoopia and the host must remain running and connected. This is a local execution channel, not a separately hosted always-on agent.

## Storage and recovery

Migration 042 adds owner settings, conversations, turns and the Telegram delivery ledger. Migration 043 adds the provider selection; Qoopia V1 uses schema 43. Verified snapshots and bundle compatibility checks include this schema. Before an update, take and verify a fresh backup through the normal update flow. Older software must not open a schema it does not support. A downgrade across a schema boundary requires a separately planned compatible restore and explicit handling of records created after the backup. The final V1 production rollout was 43 to 43: a compatible code rollback preserves the current database rather than overwriting it with a pre-release backup.

Native credentials and Telegram tokens are separate private files under the installation's memory root. They are not copied into the database snapshot. Restore invalidation disables the embedded runner, clears Telegram binding and native thread references, and revokes restored access through the existing restore policy. Review the restored agent identity and reconnect credentials before resuming; do not replay interrupted turns. The feature does not claim one-click credential recovery after restore.

## Qualification boundary

Automated checks cover migration/integrity, owner and CSRF boundaries, file isolation/downloads, history paging, sender binding, redacted transport errors, native RPC transport and a synthetic native turn with approval, persistence and deduplication. Browser evidence uses synthetic data and a local HTTP fixture. The official downloaded runtime was also provisioned and started in an isolated profile without an account.

Historical acceptance verified a real ChatGPT/Codex conversation on a separate Mac; the resulting Stop and context defects were fixed before the published V1. This does not qualify every provider, platform and channel combination. A fresh managed Claude conversation, real Telegram binding and real-account managed HTTPS enrollment remain outside that acceptance evidence. Neither screenshots, a synthetic authenticated RPC fixture nor successful process startup establish those outcomes. Verify the selected provider and channel with a real completed turn before reporting that installation connected.
