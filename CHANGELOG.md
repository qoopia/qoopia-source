# Changelog

## 5.0.17 — 2026-10-04

- External access (user report): ChatGPT and Claude.ai connect to a Mac/Linux install behind the managed
  tunnel. `/oauth/authorize` sent the browser to an unpublished dashboard path (503
  `REMOTE_CONSENT_REQUIRED`); it now opens `/oauth/consent` directly. The email or Google sign-in on that
  page confirms from the owner's own browser, the page follows the browser language, a spent email
  allowance names the way out, read connections accept clients that send no scope, token requests without
  `resource` get the consented audience, generic discovery names the tunnel issuer, and path-derived
  authorization metadata of a connection is that connection's. Retried connects no longer exhaust
  registrations; a client that revoked its grant shows as needing a new sign-in.
- Session memory (user report): local Claude Code and Codex bind to `http://127.0.0.1:<port>`, not the
  tunnel origin that never served `/memory/continuity` (HTTP 404). Hooks run through the installation
  launcher `<root>/bin/qoopia`, so an update never strands them on a pruned bundle; capture survives odd
  transcript records, records over 8 MiB, non-UTF-8 bytes, killed hooks, Mac restarts (no resend, no
  manual-mode leak) and time-zone changes; a refused delivery is told to the agent at session start and in
  `qoopia doctor`. Session memory for an agent on another computer is published through the tunnel with
  the agent key.
- Logs and backups (user report): managed logs no longer read as replaced after a Mac restart
  (`LOG_OWNERSHIP_INVALID`), a deleted or Time-Machine-restored log no longer degrades maintenance, a log
  failure no longer skips the daily backup (`BACKUP_STALE_OR_CLOCK_INVALID`), and a missed maintenance
  window is caught up after boot or sleep.
- Dashboard: "Saving needs attention" no longer fires for agents that are only polling the AgentComm inbox,
  pinging, reconnecting, or registering sessions whose runtime writes no transcript (`claude -p
  --no-session-persistence`); it is judged by real tool calls. An agent without hooks (ChatGPT, Claude
  web, a bot) whose last explicit save is older than a week shows as connected without automatic saving,
  not as saving. A connection the application never signed in through reads "setup not finished", not
  "sign in again", and no longer borrows the agent's requests over other credentials as its last use;
  cancelling it keeps an agent that already works over its own key instead of deactivating it.
- Security: an opened `.qoopia-memory` file shows its address before any hook is linked, and
  `memory-link` previews by default (`--commit --approve`). A public claude.ai/ChatGPT registration never
  binds to the steward. A same-machine restore keeps client access but re-applies every revocation,
  demotion and privacy decision made after the backup; a revoked device's grants stop working on a new
  tunnel. 401 responses carry `WWW-Authenticate`.
- Headless Linux: sign in and enable external access with a device code confirmed on another device;
  correct log location for `--root`, a systemd unit that retries and reports lingering, signal forwarding
  from the launcher, owner socket in the runtime directory, loopback connection files are not exported,
  unknown commands fail, `./qoopia open` from a newer package adopts it.
- Upgrades: same-machine restore migrates an older backup; new-machine restore over a fresh unused
  install; `use-server`/`doctor` check the server answers as Qoopia and a server-workspace computer reports
  the server, not a leftover local install.
- Dashboard and site: phone widths (tap targets, menus, consent page, sign-in polling, no false sign-out),
  revoked-device recovery, paused tunnel refuses new remote connections, truthful iPhone page, unsupported
  devices told before download, privacy page matches the code.
- Agent kit revision 11.
- Upgrade: on its first start the updated runtime moves what older versions left pinned to one bundle
  onto the installation launcher: Claude Code and Codex memory hooks (an update prunes old bundles, and
  such hooks then failed silently) and a LaunchAgent or systemd unit from `service install` (read at the
  next login; nothing restarts). Only Qoopia-written entries change, with a backup; edited ones are kept.
  **Codex:** the hook command changes once, so Codex asks to approve the Qoopia hooks again in `/hooks`.
- Memory: a local hook binding that 5.0.16 linked to the tunnel origin moves to loopback at start for the
  same agent and key; no reconnect is needed. Profiles connected through Connections receive the new
  instruction kit at start too (edited or removed instructions stay as they are).
- Visibility (OWNER DECISION, ADR-020): shared context is read-only. An agent that sees its neighbours'
  notes can read them but no longer change, supersede or delete them; it gets `FORBIDDEN` naming the
  author, with the next action. The author, the steward and the owner keep full rights. Agent kit
  revision 11 says so in the protocol (ru and en).
- Memory: the session-summary model sees a large tool output as its first 2,000 and last 1,000 characters
  with an "[… N characters omitted …]" marker, and an output the client split into 12k rows counts as one
  event. A 7 MB log now costs one small call instead of ~150, so the summary backlog drains [F-341]. The
  stored journal keeps every character.
- Agents: names may be Cyrillic (Russian, Kazakh) as well as Latin, one alphabet per name, so a Cyrillic
  «а» cannot hide inside «aaron». Names are NFC-normalized; a new name is refused when it matches an
  existing one ignoring case or reads the same across alphabets («ТОМ» against «TOM»). AgentComm,
  agent status, memory policy and connection lookups now match Cyrillic names in any case.
- Memory: automatically captured turns and session summaries keep the file paths they mention (they
  were stored as `[LOCAL_PATH]`, so a summary could not say which file changed). Secrets, tokens and
  credential URLs are still removed, and paths of credential files (`.ssh`, `.aws`, `.env`, `*.pem`,
  `*.key`, keychains, `credentials`/`secrets` folders) read `[REDACTED:credential-path]`. Logs, error
  messages and support output keep hiding all local paths.
- Search: without embeddings, a Russian word also finds its other case and number forms («миграция»
  finds «миграцию», «базы» finds «база»): recall, session search, entity and dashboard search add a
  query-side stem as a prefix term next to the exact word, which still ranks first. No reindex or
  migration; English, Kazakh and short words are searched as before.

## 5.0.16 — 2026-10-03

- Sign-in: Google sign-in lands in Qoopia at once, with no confirmation email and no code. A sign-in
  request is bound to the network it started from instead of a six-digit code: the Google return or the
  email link completes it only from that network, so a link started by someone else still signs nobody in.
  The email link page confirms by itself on the starting network; a new account gets one welcome email
  without links. Website and iPhone profile sessions last a year and renew on every visit (they ended after
  7 days). Deploy the account service before the servers; clients up to 5.0.15 keep their code.
- Dashboard: the owner is the first agent row (whole workspace, no switches), the steward second, then agents
  by runtime (Claude, Claude Code, ChatGPT, Codex, Grok, Muse, Hermes). Rows are compact with inline
  autosave and shared-context switches; the agent page opens on sessions, notes and search. Overview shows
  tiles for active agents, connections, bridges and files with a live activity feed, newest first, where a
  repeated event is one line with a count. Connections is one list of connected apps with two plain states
  and Disconnect; abandoned drafts are hidden after 24 hours. AgentComm threads show the newest message
  first. Files has folders, a path bar, New folder and Upload.
- Files: new MCP tool `file_put` lets any agent create or append a text or base64 file in its workspace
  (by default in a folder named after the agent); an agent replaces only files it uploaded.
- Memory: the maintenance worker summarises only conversations active in the last two hours; a finished
  conversation stays stored and searchable and is no longer caught up. The continuity checkpoint has its own
  model budget and yields to interactive calls; a timeout on a one-message batch backs the session off
  (F-341). The note-write clock is per workspace, and "as of now" sees a burst of writes (F-339). Recall
  starts FTS joins from the index (F-340: Linux recall 79 → 0.2 ms at 5000 notes).
- `qoopia version` reports trust from the verified bundle manifest (F-338).
- Fixes: protected-resource metadata advertises the exact OAuth resource; identity and provider responses are
  read with a size bound; `setup` names the client config under `CODEX_HOME` / `CLAUDE_CONFIG_DIR`; profile
  and local sign-in refuse duplicate cookies; the connection verification challenge is compared in constant
  time.
- Internal: one MCP tool-call path, one OAuth grant pipeline and shared helpers (`src/` −283 lines). Database
  schema stays 48; agent kit revision stays 9.

## 5.0.15 — 2026-10-02

- Access (OWNER DECISION, ADR-020): every agent has one shared-context toggle. On (the default for every
  agent, including existing ones) it reads the notes, session transcripts and agent-to-agent threads of its
  workspace's sibling agents; off, only its own. The owner switches it on the agent page in the dashboard, the
  steward with `agent_set_shared_context`. No agent reads outside its workspace (`session_search` scope `all`
  and recall `cross_workspace` stay in the workspace). `claude-privileged` is no longer a category: existing
  rows act as ordinary agents, management rights (OAuth client registration and consent) belong to the
  steward and the human owner, and new agents cannot be created with that type.
- Security hardening from the 2026-10-02 audit: session ids held by another agent or workspace answer like
  missing ones; AgentComm resolves foreign agents only inside the owner boundary and requires thread
  participation; outbound webhooks, embedder, reranker and tailer refuse redirects and bound response bodies;
  dashboard cookie mutations require `X-Qoopia-CSRF`; duplicate session cookies are refused; forwarded host
  headers count only from a trusted proxy; HSTS on public HTTPS surfaces; authenticated JSON is `no-store`;
  file downloads are served as octet-stream with a CSP sandbox; a URL parameter can no longer widen an MCP
  connection's access profile; uploads from OAuth connections are refused.
- HTTP: request bodies get a delivered 413/408 and idle keep-alive sockets close after 30 s; client-input
  errors keep their 4xx; wrong methods get 405 with `Allow`; HEAD answers like GET without a body; a
  read-only database is refused before the port is bound; a newer schema than the build is refused at start,
  migrate and `/ready`; `/ready` reports write capability and free space (`QOOPIA_MIN_FREE_BYTES`, default
  64 MiB).
- Sign-in: hosted e-mail owner sign-in is bound to the browser that started it with a six-digit code (deploy
  the account service before the servers); owner sign-in start is rate limited per client so it cannot be
  locked out.
- Memory and recall: recall shares its 4 KB budget across rows, drops stop words, keeps one-character CJK
  terms and control-free FTS queries; `session_save` accepts an optional `message_id` for retries; note
  writes take the write lock up front; maintenance survives referenced task-bound rows; built-in embeddings
  run in a worker (no first-recall stall) and load in the standalone build.
- Dashboard: one server-side search request per query with paging, notes paging, polling keeps focus,
  localized error states with Retry, design tokens from DESIGN.md, accessibility fixes (axe: 0 violations).
- Install and delivery: `qoopia open` keeps serving without a browser and prints an SSH tunnel hint; clear
  messages for not installed, already running and port in use; interrupted installs and uninstall leave a
  root that installs again; updates refuse downgrades, show versions in the plan and prune old bundles; a
  rolled-back desktop update stays rolled back; the agent kit ships in English beside Russian (kit revision
  9); new `memory-unlink` and `instructions remove` commands.
- Release and operations: both images run a verify stage and carry Qoopia OCI labels; the sign-in image is
  stamped and reports `release_sha`; `release-health` sends OK/ALERT transitions to the owner's alert
  channels (`QOOPIA_OPS_CHANNELS_FILE`); CI runs once per commit, advisories run as a separate daily job;
  lint denies warnings and typecheck covers tests, benchmarks and the SDK.
- Database schema 48: migration 048 adds read-path indexes (agent list, AgentComm inbox, files, note deletes) and
  corrects legacy `updated_at_ms` values left 1 ms early. Startup stays schema-read-only: take a backup and run
  `bun run migrate` before starting the new release.
- Website: download button clicks are counted anonymously for everyone (as before); docs#privacy now says so.
  Page views and other site statistics stay opt-in.
- Data, log, backup and export directories, and exported files, are refused when they stay group/other
  accessible after Qoopia tightens them to 0700/0600. This used to be a warning; now startup, install,
  scheduled backups and exports stop. Before upgrading, check that `data`, `logs` and `backups` under
  `QOOPIA_ROOT` are owned by the server user or already 0700.
- Without `QOOPIA_INSTANCE_ID`, the instance identity in `/health` and `/ready` is `<role>:<port>` and no
  longer contains the machine hostname. A legacy `export_bundle` replay that spans this upgrade on such an
  instance is refused as a conflict; set `QOOPIA_INSTANCE_ID` to the previous value to keep it stable.

## 5.0.14 — 2026-09-30

- Agent onboarding confirms the first successful qoopia_protocol call on the exact OAuth connection. No temporary verification prompt is needed in the dashboard; older clients retain compatibility.
- Owner consent reuses the signed-in browser session, including cross-site entry with SameSite cookies. Client permissions remain explicit; agent tokens cannot stand in for the human owner.
- Pending applications stay visible; one setup request, clipboard recovery, and automatic status refresh replace the previous verification steps.
- Instruction refresh preserves agent identity and container-local reader paths. Protocol kit revision 7; database schema remains 47.
- Updated browser acceptance covers the new onboarding path. Existing verified connections, agents and memory policies are retained.

## 5.0.13 — 2026-09-30

- Update MCP transitive dependencies fast-uri and ip-address to patched versions; dependency audit reports no vulnerabilities.

- Distinguish Muse.app from Muse Code CLI; retain existing verified connections and accept meaningful agent names.
- Let the steward prepare a scoped owner review link without creating duplicate agents or granting access.
- Copy setup and verification together for cloud Muse and Grok Bot; display native connections and unfinished drafts accurately.
- Recover timed-out memory checkpoints using smaller source batches. Publish instruction kit revision 6; schema remains 47.

## 5.0.12 — 2026-09-24

- Add guided remote MCP setup for Muse Code and Grok Bot while preserving existing client connections and OAuth records (schema 47).
- Make the built-in ChatGPT/Claude agent more responsive in the dashboard and Telegram: lighter status reads, batched native output persistence, visible tool progress, lazy folder listing, and a bounded inactivity recovery path.
- Keep Profile and the owner-only panel inside the signed-in dashboard. The owner panel remains restricted to the configured human owner account.
- Publish protocol kit revision 5 with setup guidance for the added clients. Native iOS remains a separate TestFlight version/build.

## 5.0.11 — 2026-09-23

- Open Profile inside the signed-in dashboard on Mac, web and mobile without asking for another email sign-in. Keep workspace details and logout in the same session.
- Keep the separate owner panel behind its own account-service authorization; no permissions or stored data change.

## 5.0.10 — 2026-09-21

- Linked native agents refresh managed instructions at session start, preserving role and user edits. Stale kits are visible in protocol and health responses.
- Explicit instruction refresh reports failed profiles and refuses downgrades.
- Release schema is derived from verified signed package inventories and must agree across platforms.

## 5.0.9 — 2026-09-21

- Theme-aware favicon: black in light browser chrome, white in dark chrome.
- Approved Graphite logo, typography and palette in sign-in and update emails, connection guides and compatibility asset URLs.
- Remove obsolete font payloads; retain readable email font fallbacks.
- iPhone installation page explains native TestFlight access and shows its actual availability.
- Includes the 5.0.8 email-to-dashboard handoff fixes for connected iPhone workspaces. Schema remains 46; existing data and connections are preserved.

## 5.0.8 — 2026-09-21

- Ship the approved Graphite dashboard: Overview on entry, compact single-column navigation and a persistent chat available across pages.
- Keep agent setup, subscription sign-in, real provider/model selection, approvals, Stop and Telegram inside the chat panel; retain drafts and conversations when navigating.
- Apply the exact approved Q mark, wordmark and Manrope to dashboard/account surfaces and the Mac app/tray. Responsive layouts retain mobile touch targets and English/Russian copy.
- Preserve the signed legacy-installation upgrade compatibility fix from 5.0.7. Schema remains 46.
- Native iPhone project is included in source; TestFlight distribution remains pending Apple signing and upload and is not part of this desktop release.

## 5.0.7

- Fix local desktop upgrades from 5.0.4 and earlier inline-dashboard packages.
  The new bundle verifier incorrectly required an extracted dashboard script in
  the old signed installation, stopping launch with “could not prepare this update”.
  Existing data, connections and the normal signature/inventory checks are preserved.
  No database schema change.

## 5.0.6

- Returning from «only on request» to automatic no longer costs a batch of messages. A client
  replays from its own cursor, so the batch that resumes a session carries turns from the manual
  period and turns from after it; the whole batch used to be dropped to be sure of excluding the
  first kind. Each message is now judged on its own: while an agent is manual the server records
  the ids it refuses — identifiers only, never text, role or any digest — and drops exactly those
  on replay. The message timestamp remains the second filter, for a client that was away for the
  whole period. Schema 46.

## 5.0.5

- The owner can confirm or decline a manual agent's prepared save straight from Telegram. The
  question is asked once, only the bound owner can answer it, and a decided or expired request
  never reaches the chat.
- Codex accepted for the first time against the real client, alongside Claude Code. Codex needs its
  project trusted and its hooks trusted once in `/hooks`; `scripts/memory-policy-canary.ts
  --hook-trust bypass` exercises the adapter without that trust and reports which was used.
- Corrected what the manual guarantee covers. A client keeps its own delivery cursor, so a turn
  held during manual can still leave an empty session row once auto returns — an id and a timestamp,
  no messages, no summary, no note. Its content is what never exists. Refusing the row was tried and
  reverted: it dropped the first batch after the switch, losing a real auto turn instead.

## Unreleased

- Deployed to the hosted server on 2026-09-20: schema 45, release `936ab4d`. Existing agents keep
  automatic saving; nothing was switched to «only on request».
- A prepared save in «only on request» no longer touches the database at all — it waits in the
  server's memory and only the owner's decision writes the note.
- Closed the remaining ways into memory while an agent saves only on request: agent tasks,
  `skill_upsert`, `extraction_preview`.
- A manual period can no longer be backfilled, and the guard no longer depends on the client clock.
- Eight existing agents connected to automatic capture in their own runtimes.

- Dashboard and OAuth consent pages no longer allow inline scripts (`script-src 'self'`); the bridge invite
  page allows its one script by hash. Inline styles remain allowed and are named as the residual exception.
- One agent contract: `qoopia_capabilities` reports every mechanism as available, forbidden,
  client_unsupported, needs_setup or faulty, with the reason and the action; the agent card shows the same.
- «Только по команде»: a note from a manual agent waits for the owner's confirmation (24 h, one use);
  `note_update`, `session_summarize` and `entity_upsert` follow the same policy.
- A manual agent's dashboard/Telegram chat keeps no conversation text in the database.
- A manual period can no longer be backfilled by a client that kept its transcript cursor (found by the
  real-client canary, `scripts/memory-policy-canary.ts`).
- Per-agent memory policy: automatic capture stays on by default; the workspace owner switches one agent to manual and back with a single command. Manual records nothing new while reading, restoring and the conversation keep working. Schema 45.
- The release monitor requires an explicit expected schema instead of a built-in number.
- The profile news form shows localized messages instead of raw network errors.
- New migrations state reader/writer compatibility, the chosen recovery and the fate of later data.

## 5.0.4 - 2026-09-17

- Telegram pairing, pending messages and delivery receipts persist across a restart; subscription sign-in resumes waiting work automatically.
- Stop cancels the active task and the queue.
- Permission requests and subscription recovery are available directly in the dashboard.
- Claude finishes writing its native transcript before completing a turn, so assistant replies survive when a conversation continues.
- Schema 44. Details: docs/operations/unified-release-504-20260917.md.

## 5.0.3

- Consolidate authorization checks and preserve administrative write access consistently.
- Split dashboard sessions and recall configuration; remove unused code and reduce runtime dependency cycles.
- Parse runtime dependencies with TypeScript and reject new cycles.
- Authenticate packaged inventories and require matching source commits before generating release metadata.

## V4 Closeout - 2026-07-17

- finalized Qoopia V4 release closeout from accepted runtime SHA `9249309c69572f42a4cc8fa838f85089c93f39eb`
- live production runtime version at closeout remained `4.0.0-rc.1`; the `v4.0.0` release tag is created only after final independent PASS
- closed controlled rollout through production Rings 2-6 with schema 32, green `health`/`ready`, and global V4 behavior flags enabled
- kept `QOOPIA_V4_EVENT_OUTBOX=false` during closeout; external event egress remains separately authorized
- recorded fresh verified production backup `pre-v4-final-20260717T224608Z`
- published final release manifest, closeout draft, and P10/P11 checkpoints
