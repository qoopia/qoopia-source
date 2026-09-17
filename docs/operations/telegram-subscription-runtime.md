# Telegram subscription runtime: implementation and acceptance

## Status

Implementation branch only; **not a release or deployment acceptance**. The active
Liam runtime and its bot are outside this change and must not be replaced.
Only the owner's explicitly designated `Tester / @qoopia_bot` may be used in the
isolated real-client fixture.

The subscription-only requirement remains: managed ChatGPT sign-in in Codex;
Claude's own subscription sign-in in Claude Code; no API-key or billing fallback.
The owner approved the existing structured Claude Code adapter on 2026-09-17
for acceptance using the same Tester bot. Qoopia owns Telegram delivery and the
durable queue; official Claude Code executes tasks through subscription sign-in.
The previously researched official Telegram Channels plugin does not provide the
deterministic Telegram Stop or Qoopia durable inbox implemented here. This change
hardens the existing bridge; it does **not** implement or qualify a native Claude
Channels migration, and does not claim Anthropic endorsement of Qoopia.

## Behavior changed

- Telegram pairing, candidate confirmation and the reopen link survive restart.
  Plain `/start` provides instructions; expired links can be replaced in the UI.
  Confirmation is committed locally before its greeting is delivered.
- Incoming prompts and receipt offsets commit together. A slow provider starts in
  a separate worker. Unique update IDs prevent duplicate prompt submission.
- Telegram keeps its own conversation ID. Selecting another dashboard chat does
  not redirect the next Telegram message. Switching providers requires finishing
  or stopping the pending queue. Each receipt also records its original provider;
  a concurrent subscription switch cannot run that prompt on a different provider.
- Stop bypasses both the dashboard request lock and the server action lock. It
  cancels queued work and terminates the owned provider process, including stalled
  initialization and Claude subscription checks. Startup and turn submission are
  fenced against concurrent Stop.
- Outgoing messages are durable; long replies are split without breaking surrogate
  pairs. Explicit Telegram 429 responses observe `retry_after`. Ambiguous delivery
  is exposed and never blindly replayed. This is **not exactly-once Telegram
  delivery**: the Bot API provides no sendMessage idempotency key.
- Polling uses long polling and bounded error backoff. Disconnect/reconnect rotates
  a generation ID so late polls/replies cannot alter the replacement binding.
- Only confirmed private-chat users can start work or approve simple commands.
  File edits and other permissions still require their dashboard preview.
- Schema 44 carries these receipts in verified backups. Restore invalidates the
  pairing and cancels pending work instead of executing an old queue.

## Validation

Automated regression:

```sh
bun test tests/telegram-recovery.test.ts tests/my-agent.test.ts tests/claude-agent-runtime.test.ts tests/codex-app-server.test.ts
```
The new cases include a separate process reading saved pairing state, storage
failure before acknowledgment, stale polls, rate limiting, ambiguous sends, long
Unicode replies, ten queued prompts, Stop during startup, migration and restore.

Browser regression uses real dashboard HTML with synthetic API responses:

```sh
python3 tests/helpers/telegram-browser.py --base http://127.0.0.1:43871 --out /ABSOLUTE/EVIDENCE
```

It checks expired-link recovery, reload persistence, keyboard focus, and that Stop
is actually sent while another dashboard request remains in flight. It never
sends real Telegram messages or signs in to a provider.

Also required: typecheck, lint, strict V4.1 lint, module boundaries, full Bun suite,
and the separately isolated `bun run test:storage-full`.

## Isolated real-client fixture

```sh
bun run scripts/telegram-acceptance-fixture.ts --run --root /ABSOLUTE/NEW/PRIVATE/ROOT --bot qoopia_bot --port 43871
```

Uses a new SQLite database, owner, agent folder and provider login stores. The
fixture refuses a different bot username before saving its token. It binds only
to loopback. A MacBook may access it through an explicit loopback-only SSH reverse
forward over Tailscale. For Codex browser OAuth on another computer, forward the
actual callback listener as well; do not copy authentication files between hosts.
Restart with the same arguments plus `--resume` to retain the synthetic database
and isolated provider stores. Dashboard cookies now persist across fixture restarts in its private session-key file.
Moving from the earlier ephemeral fixture requires one fresh login. Type `login` in the fixture terminal for a five-minute local code.
Tokens go only into the password field, never into the report or chat. Ctrl-C
stops the fixture's own runtimes; it also stops after two hours. Close the SSH
forwards and remove the private fixture data after acceptance.

Before release, prove real subscription mode, pairing and replies for each
accepted provider path, context continuity, synthetic Qoopia MCP read/write,
restart/resume, a busy queue, permission approval, Stop, network loss, quota/auth
failure and the second-host conflict. Test results with synthetic provider
processes do not substitute for these real-client checks.

## Real Tester acceptance — 2026-09-17

ChatGPT/Codex path exercised with the owner's isolated subscription profile and
`@qoopia_bot`. This qualifies the development fixture, not a published installer.

Confirmed against real Telegram and Codex:

- Original queued prompt and follow-up both answered; `САПФИР` retained in the
  same Telegram conversation, also visible in the dashboard.
- Runtime restart retained pairing, native subscription authentication and
  conversation context (`RESTART-0917`).
- `/stop` interrupted a real `sleep 45` turn and cancelled the next receipt before
  a run was created. A subsequent message started normally.
- Two messages remained ordered while the first waited for MCP approval
  (`ALLOW-0917`, then `QUEUE-ORDER-0917`). Dashboard Decline and Allow once both
  exercised the native MCP approval protocol.
- Native agent created and read synthetic note `01M2RQ4QSC1KPEVN5QKK9AQHV7` with
  text `TESTER-MCP-0917 BLUE-KITE; no personal data`. Telegram delivery confirmed.
- With the isolated profile's auth file temporarily withheld, an incoming prompt
  stayed queued. Authentication was restored in that same profile, then a runtime
  restart resumed the saved prompt without another incoming message
  (`AUTH-RECOVERY-0917-OK`). This is controlled auth-loss recovery, not a second
  interactive OAuth login. The login-completed notification path is covered by a
  native-protocol fixture regression.
- A competing real `getUpdates` call produced HTTP 409 and the fixture reported
  the conflict. Polling and later replies recovered after the competitor exited.
- `/new` made a different Telegram conversation; its new reply succeeded and the
  preceding conversation remained stored.
- Browser reload and subsequent server restart preserved the owner session in the
  updated fixture. MacBook loopback tunnel returned HTTP 200.

Additional fixes from acceptance:

- Separate explicit Stop (paused=1) from waiting for subscription (paused=2).
  Successful subscription login resumes only authentication waits; stopped work
  cannot be resurrected by a later login notification.
- Native `mcpServer/elicitation/request` confirmation is shown for review instead
  of being silently refused. Empty confirmation forms support accept/decline;
  forms requiring input and URL elicitations remain explicitly unsupported and
  cannot be accepted as empty forms. Permissions and annotations were not weakened.
- Interrupted/failed Telegram replies explicitly identify their terminal state,
  including when a partial model answer already exists.
- Fixture session keys persist privately across restarts. The prior UI session
  restoration/near-composer recovery fix is in commit `ffa8d58`.

Validation: 1364 passed, 1 intentionally isolated skip, 0 failures; separate T27
storage-full check 2 passed. Typecheck, module boundaries, project lint, strict
V4.1 lint, and strict lint of changed TypeScript passed. Network loss, explicit
429 cooldown, ambiguous sends, Unicode chunk delivery, provider failure and
no automatic replay/fallback are controlled fault-injection regressions. A real
subscription's quota was not deliberately exhausted.

Limitations/open gates:

- Claude adapter choice and isolated real subscription acceptance are complete;
  see the qualification and limits below.
- The native API-key MCP profile with the temporal feature disabled does not
  advertise `note_create.idempotency_key`. The initial extra idempotency probe
  correctly refused to invent that argument. Create/read passed using the actual
  schema. Connection-bound ChatGPT MCP and service idempotency tests are separate.
- No private/public push, merge, deployment, packaging or release was performed.
  Liam's runtime, bot and configuration were not changed.

## Claude acceptance — 2026-09-17

The owner approved Qoopia's Telegram queue plus official Claude Code, then signed
in interactively from MacBook. The managed binary was **Claude Code 2.1.224**,
not the newer CLI in the owner's default profile. Native `auth status` confirmed
the subscription path in the isolated Tester profile; no API-key fallback or
credential copying was used.

Real results with the same `@qoopia_bot`:

- The message queued before login executed automatically after the OAuth code
  was submitted: `CLAUDE-0917-OK`. No new incoming message was needed.
- Follow-up recalled `ЯНТАРЬ`; the same word was recalled after backend restart.
  Pairing and native subscription authentication persisted.
- MCP protocol/capabilities, note creation and reading used normal per-tool
  approvals. Synthetic note `01M2RSM5D71ZJJFDN1FHA4JX10` contains
  `CLAUDE-TESTER-0917 AMBER`; storage and Telegram delivery were verified.
- `/stop` interrupted a live MCP permission wait. The following queued message
  was cancelled with no run created; no approval remained. `/new` then created
  a separate conversation and subsequent work succeeded.
- Dashboard Decline produced `DECLINED-0917` without another tool attempt. The
  queued `QUEUE-0917-OK` followed it in order.
- Claude generated `ЖУРАВЛЬ ТУМАН 5382` itself. After another backend restart it
  reproduced that exact answer without tools or the code in the follow-up prompt.

Acceptance exposed a native-history bug: terminating Claude immediately on its
result event could kill it before its assistant response was flushed to disk.
Subsequent resumes then treated already-answered questions as unanswered. Normal
completion now closes stdin and waits for native exit, with a three-second forced
termination fallback. Stop and failures still force termination. A regression
test verifies that native history is persisted before completion and resume.
Live native transcripts and the generated-code recall confirmed the fix.

The first Stop probe used foreground `sleep 45`, which native Claude refused.
It was not counted as a successful Stop test and the refusal was not bypassed.
Real Stop was tested during an approval wait; termination of detached child
commands is separately covered by the process regression. Shared Telegram
network/rate-limit/ambiguous-delivery and provider-failure regressions remain
controlled fault injection, not deliberate exhaustion of a real subscription.

Final checks: **1365 passed, 1 isolated skip, 0 failed**; separate T27 **2 passed**.
Typecheck, project lint, strict changed-file/V4.1 lint, module boundaries and diff
checks passed. Evidence: `../outputs/telegram-runtime-research-20260917/CLAUDE-ACCEPTANCE-0917.json`.
The MacBook SSH endpoint was unreachable at the final tunnel check; this does not
invalidate the recorded native/Telegram runs, but current MacBook reachability
is not claimed. This is development-fixture acceptance only. No release, deploy,
merge or push was performed; Liam remains outside the test.
