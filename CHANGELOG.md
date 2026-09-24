# Changelog

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
