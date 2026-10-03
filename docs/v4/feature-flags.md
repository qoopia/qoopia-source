# Feature flags and effective defaults

> Historical V4 freeze table. The live flag set is `getV4FeatureFlags()` in `src/utils/health-metadata.ts`, reported as `/health.feature_flags`: it adds `QOOPIA_V4_BITEMPORAL` (V4.1) and no longer has `QOOPIA_V4_AGENTCOMM_RECEIPTS`.

All V4 behavior flags default to `false`. Missing, empty, or any value other than the exact string `true` is false. Flags do not bypass OAuth scope, risk profile, instance-role, workspace, private visibility, or owner-GO gates.

| Flag | Default | Effect when true | Rollback |
|---|---:|---|---|
| `QOOPIA_V4_RELATIONS` | false | relation services/tools and relation-aware expansion may run | disable; metadata mirror remains readable |
| `QOOPIA_V4_LATEST_ONLY` | false | omitted `latest_only` becomes effectively true after relation readiness | disable to restore baseline result selection |
| `QOOPIA_V4_RECALL_EXPLAIN` | false | explain fields, bounded trace creation/read | disable; retained traces expire normally |
| `QOOPIA_V4_LIFECYCLE` | false | bounded lifecycle factor and deferred reinforcement | disable; state remains unused |
| `QOOPIA_V4_EXTRACTION` | false | proposal runs and review tools | disable; pending reviews remain durable |
| `QOOPIA_V4_FEEDBACK` | false | feedback writes and subsequent-call lifecycle effects | disable; recorded feedback remains audit data |
| `QOOPIA_V4_EVENT_OUTBOX` | false | reserved: no runtime producer reads it (the rollout gate still refuses it); ops alerts use the signed delivery transport directly | disable; canonical transactions remain committed |
| ~~`QOOPIA_V4_AGENTCOMM_RECEIPTS`~~ | — | removed with the receipt ledger in `40b123a`; nothing reads it | — |
| `QOOPIA_V4_DASHBOARD` | false | additive V4 dashboard routes/views | disable; existing dashboard remains unchanged |

Existing `QOOPIA_ENTITY_PAGES` and `QOOPIA_SKILLS` retain their V3 behavior and are not redefined by V4.

## Request override rules

- `include_history=true` requires existing `include_archived=true`; it makes effective `latest_only=false` unless the caller explicitly also sends `latest_only=true`. Either missing archive opt-in or the explicit latest conflict is `INVALID_ARGUMENT`.
- Explicit `latest_only=true` requires both relations and latest-only flags.
- Explicit `explain=true` or `trace=true` requires the explain flag.
- Explicit `lifecycle=true` requires the lifecycle flag. Explicit `lifecycle=false` may disable lifecycle for one call.
- Requesting a disabled capability returns `FEATURE_DISABLED`; the server never silently enables or ignores it.

Canary allowlists contain canonical agent IDs resolved at rollout time and live only in sanctioned configuration. Product code and committed configuration contain no fleet names or role assignment lists.
