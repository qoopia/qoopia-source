# Qoopia V4 rollback

Rollback is a controlled production mutation. A failure trigger does not waive the exact-SHA review, action-specific owner GO, backup, integrity, Compose-runner, or evidence gates.

## Trigger matrix

| Trigger | Immediate safe action | Next reviewed action |
|---|---|---|
| V4 behavior/SLO regression without corruption | stop enabling rings; preserve redacted evidence | disable V4 flags in reverse dependency order under deploy/restart GO if reload requires restart |
| Compatibility or startup regression | keep the service stopped if already stopped | deploy the previous exact immutable image and previous reviewed compose under rollback GO |
| AgentComm duplicate/loop | disable receipt-consumer acceleration; ledger remains authoritative | verify request/ACK/reply/close ledger and transport idempotency before retry |
| Migration/backfill verification failure | do not start either binary automatically | diagnose on a clone; use code-first rollback when additive schema remains healthy |
| Proven corruption/irreversible write | stop all writers and preserve evidence | restore only the exact verified pre-change backup under a separate restore GO |

## Order of operations

1. Freeze further rollout and capture redacted health/error-code evidence.
2. Turn feature flags OFF in reverse order: extraction/receipts/lifecycle/latest-only, then relations. Event outbox remains OFF unless separately authorized.
3. If required, deploy the previous exact immutable image through the reviewed previous compose manifest. Never use a mutable tag, dirty source bind mount, `git reset`, `git checkout`, or `docker restart` for configuration changes.
4. Verify health, release SHA, schema, V3 client contract, integrity, FK count, and 943/943 legacy coverage.
5. Restore the database only for demonstrated corruption, only from the bound 0600 backup, only with separate restore GO, and only after the restore rehearsal is reproduced.

## Evidence

Record owner message ID, action, release/previous SHAs, image IDs, backup hash and age, compose hash, timestamps, commands/exits, health/schema/contract results, trigger, and rollback duration. Never record `.env`, tokens, cookies, note bodies, private messages, or backup contents.
