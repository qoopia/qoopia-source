# Agent memory policy — auto and «Только по команде»

Introduced in schema 45; current replay ledger uses schema 46. One server-side setting per agent identity decides whether Qoopia records that agent's
conversations by itself, and one contract tells every agent what it can use. Status of this document: describes the implementation in the repository; it is
not a claim that the change is deployed. Deployed state: `python3 scripts/project-status.py --live`.

## Model

| | |
|---|---|
| Storage | `agents.memory_mode` (`auto` \| `manual`), `memory_mode_revision`, `memory_mode_updated_at_ms`, `memory_mode_actor_id` |
| Scope | `(workspace_id, agent_id)` — shared by every connection and device of the agent; survives restart and update |
| Default | `auto` for new and existing agents (the behaviour before schema 45) |
| Change log | `agent_memory_policy_log` — who, when, which mode, which revision. Never conversation content |
| Who may change it | the workspace owner (`agents.type='owner'`, `authority_profile='owner'` or `workspace_owners`). A steward may list, not switch. An agent never switches itself or another agent |

## Commands

- MCP: `memory_policy_set {agent, mode, expected_revision?}` and `memory_policy_list`. `agent` is an id or
  an exact name; a name matching several agents is reported, never guessed.
- Dashboard: the agent card → «Память разговоров» → switch. `POST /api/dashboard/agents/:id/memory-policy`
  requires an allowed Origin, `X-Qoopia-CSRF` and an owner session; OAuth-backed sessions are refused.
- The change is atomic and idempotent: repeating a command that already holds returns the current state and
  does not raise the revision. `expected_revision` mismatch → `STALE_REVISION` (409).
- An agent sees its own policy in `qoopia_capabilities.memory_policy`; it is part of `config_digest`.
- Explicit saves of a manual agent: `memory_save_list {agent?}` and `memory_save_decide {id, accept}` (owner
  only), or the agent card → «Ждут вашего подтверждения». `GET /api/dashboard/memory-saves` and
  `POST /api/dashboard/memory-saves/:id` carry the same guards as the policy route.
- «Покажи, у кого что работает»: `qoopia_capabilities {agent:"all"}` for the steward or the owner; one agent
  by id or exact name returns its full contract.

## What manual stops, and what it does not

Stops: automatic session capture (hooks, `session_save`, the legacy tailer, the My Agent / Telegram copy),
automatic summaries, and every note derived from new session content.

Keeps working: reading, search and restore of existing memory; the conversation itself; explicit saves
confirmed by the owner. Nothing already stored is deleted.

What manual does not remove is the session row itself. A client keeps its own delivery cursor, so once
auto returns it re-sends the turns it held; their content is refused, but the batch can still open an
empty session — an id and a timestamp, no messages, no summary, no note. Closing that gap was tried and
rejected: refusing to open the session also drops the first batch after the switch, and losing a real
auto turn is the worse failure. The guarantee is therefore about content, and the canary asserts exactly
that — content in the auto sessions only.

### The chat of a manual agent: temporary state, not history

A chat needs some state to work at all. Writing the turn to another table (`qoopia_agent_runs`) instead of
session memory is still Qoopia storing the conversation by itself, so a manual agent's turn is handled
differently. This is the whole of what exists, where, why, and until when:

| What | Where | Why it is needed | Gone when |
|---|---|---|---|
| Prompt and answer of the current and recent turns | process memory only, at most 100 turns | show the reply in the dashboard, hand it to Telegram | the process restarts, or 100 newer turns arrive |
| A Telegram message waiting for its turn | `qoopia_telegram_inbox.prompt` | Telegram is acknowledged before the turn starts; without a durable queue a crash loses the message | the turn is submitted (blanked in the same transaction), or the message is cancelled/failed |
| A Telegram reply being delivered | `qoopia_telegram_outbox.body` | retry after a rate limit; a restart must not repeat sent chunks | the chunk is sent, cancelled or uncertain |

The run row itself stays, without text: id, state, timestamps, the idempotency key of the request. After a
restart the dashboard shows «Не сохранено: агент сохраняет только по команде» for such turns, and an
undelivered Telegram reply is reported as not kept instead of being invented. A turn that began under auto
and ends after a switch to manual loses its text the same way. The conversation's own history lives in the
provider's thread (Codex, Claude) — outside this setting, as stated in the UI.

Outside this setting: the history kept by Claude, ChatGPT or Telegram themselves; AgentComm, skills, bridges
and file operations, which have their own records and permissions; the skills task log (`agent-task`), which
is the record of an owner-started task rather than session capture.

## Enforcement

Every path that records session content goes through `saveMessage()`; the policy is checked there, inside
the write transaction. Origin is decided by the server at the call site (`automatic` by default,
`owner_confirmed` only for a confirmed owner action) and is never read from a request body.

| Point | Behaviour in manual |
|---|---|
| `continuityEvent` (start/progress/precompact/end hooks) | returns the existing context, `accepted: []`, `memory_mode: "manual"`; writes no message and does not create or flag the session |
| `saveMessage` (all callers) | `APPROVAL_REQUIRED` unless the origin is `owner_confirmed` |
| `createNote` / `updateNote` (MCP `note_create`, `note_update`, V2 aliases, extraction acceptance) | held as a save request, `APPROVAL_REQUIRED`; re-checked inside the write transaction |
| `session_summarize`, `entity_upsert` | `APPROVAL_REQUIRED` — not a side door for conversation text |
| replay of a manual period after the owner returns to auto | acknowledged and dropped by message ID / timestamp; an empty session row may remain |
| `checkpointSession` | refused before the model is called; a summary that started under auto and finishes after the switch returns `policy_changed` and commits nothing |
| maintenance worker | selects only agents in auto |
| `POST /ingest/session` (tailer) | answers 200 `{skipped:"memory_mode_manual"}` so the tailer advances its cursor — no endless retry, no backlog |
| My Agent / Telegram | the chat keeps working; its text stays out of SQLite (see «temporary state» above) |

Switch timing. `auto → manual`: the server refuses automatic writes from the committed change on; a model
call already in flight cannot be recalled from the provider, but its result is discarded. `manual → auto`:
capture starts at the current position; material from the manual period is not backfilled, including on
replay of an old queue. Known ceiling: an external client that buffers locally stops sending only when its
next request is refused; the server never stores what it sends in between.

Replay. A client adapter keeps its own transcript cursor. In manual the adapter asks the server with
an empty probe before sending anything, so the conversation does not leave the computer. For adapters
installed before this change, and for anything else that re-sends, the batch that resumes a session
carries both halves: turns from the manual period and turns from after it. Each message is judged on
its own, so nothing from after the switch is lost.

- **By id, needing no clock.** While the agent is manual the server sees each batch and refuses it,
  and it records those message ids — identifiers only, never the text, the role or any digest. When
  the client replays, those exact ids are dropped and the rest is kept. This is what makes the mixed
  batch separable, and it is why a whole batch no longer has to be sacrificed.
- **By timestamp, as the second filter.** It still covers a client that was away for the entire
  period and so never showed those ids here, and it falls back to the server's receipt time rather
  than failing open.

The ledger is pruned after a month: a cursor that has not replayed by then never will. Both filters
would have to miss for manual content to be admitted — the client would have to have been absent for
the whole period *and* report a wrong clock.

## Explicit save in manual

The server cannot prove that the user asked from a flag supplied by the model, so nothing the agent
sends counts as consent — and unverified material must not reach the database either. A note written
by a manual agent is held **in the server's memory only**:

1. `note_create` (or `note_update`) validates as usual, holds the prepared note in process memory and
   answers `APPROVAL_REQUIRED` with the request id and deadline. Nothing reaches `notes`, FTS,
   embeddings or any table.
2. The owner sees the prepared text on the agent card or with `memory_save_list`, and confirms or
   declines. Only the workspace owner decides; an agent never confirms its own request.
3. Confirming writes exactly the prepared note, under the asking agent's identity, once, and records
   a `memory_save_decisions` row: who decided, which note resulted, never the text. Repeating the
   confirmation returns the same note; the agent asking again later gets that note too.

Limits: 24 hours, 20 pending per agent and 200 per process (`RATE_LIMITED` beyond that), one request
per identical material. A restart discards everything not yet confirmed — that is the point, not a
defect, and the refusal message says so. Arguments such as `origin` or `explicit` never reach the
writer. Every other door is shut the same way: `note_update`, `session_summarize`, `entity_upsert`
(guarded on the writer, so `skill_upsert` is covered too), `extraction_preview`, and the agent-task
transcript, which records under the target agent's identity and is refused rather than written
behind its back.

The owner can confirm in the dashboard, through an owner connection, or with the Telegram confirmation button (available since 5.0.5). Only the bound owner can decide.

## One agent contract

`qoopia_capabilities` answers the same way for a new and an existing agent. Next to operations, limits and
`config_digest` it returns `contract: qoopia-agent-contract/1`, the protocol kit revision, the agent's
connection record and `mechanisms` — one row per mechanism:

| Status | Meaning | Example |
|---|---|---|
| `available` | the agent may use it now; `tools` lists what it gets, `withheld` what it does not | notes for a read-only agent: `recall` yes, `note_create` withheld |
| `forbidden` | rights or the owner's policy say no | management for a standard agent; automatic capture in manual |
| `client_unsupported` | the client cannot do it | automatic capture for ChatGPT web/desktop, Claude web/desktop |
| `needs_setup` | exists, but something must be connected or switched on | no adapter has reported; knowledge pages off; bridges without a selected agent |
| `faulty` | it should work and does not | summaries behind, memory model sign-in or quota |

Mechanisms: notes/recall/brief, session log, automatic capture and restore, AgentComm, skills, knowledge
pages, bridges, files, export/import, management. Rows come from the real tool registry through the same
predicates MCP registration applies; `tests/agent-contract.test.ts` pins the two together and refuses a
tool that belongs to no mechanism. A full catalogue is not owner rights: `forbidden` rows list no tools.
The agent card shows the same rows; REST `/api/v1/capabilities` and the CLI `capabilities` command return
the same object. Live status is reported beside `config_digest`, not inside it. Evidence levels stay
separate: a protocol file on disk, a protocol read through `qoopia_protocol`, and a function actually
executed are three different facts, and the contract claims only what the server can see.

Ceiling: a connection opened with `?profile=full` sees the wider legacy discovery surface; the contract
describes the agent, not that URL. OAuth scope narrows the agent's own answer, not the owner's overview.

## Runtime support

| Runtime | Automatic capture | PreCompact / SessionEnd | Note |
|---|---|---|---|
| Managed Claude Code (Qoopia memory client) | yes | yes | hooks installed by the Qoopia installer |
| Managed ChatGPT / Codex (Qoopia memory client) | yes | per Codex hook support of the installed version | same pipeline |
| My Agent in the dashboard / Telegram | yes | n/a — every turn is recorded | policy of the My Agent identity |
| Standalone native CLI / Desktop without the memory client | no | no | needs the memory client; otherwise MCP-only |
| MCP-only external clients (incl. Grok Bot) | best effort only | no | a «save every turn» prompt is not automation; full coverage needs a supported client adapter |

## Acceptance

Run `scripts/memory-policy-canary.ts` with isolated synthetic identities. Verify automatic capture, manual refusal, owner-approved save, replay, new-session restore and resumed capture without importing the manual period. A working adapter and real-client acceptance are separate from a connected MCP token.

The owner may switch a named agent with `memory_policy_set`; no real policy is changed by this documentation. Check `qoopia_capabilities` from the actual client for supported mechanisms.
