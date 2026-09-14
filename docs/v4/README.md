# Qoopia V4 architecture freeze

Status: P01 fix-pass candidate, ready for independent review
Baseline: `integration/v4@b6c169b9c72a2f983933610072b4909ef61261c3`
Accepted database baseline: schema 26
Frozen V4 target: schema 32

This directory is the implementation contract for P02 through P09. It consumes the accepted migration amendment through [ADR-V4-0001](../decisions/ADR-V4-0001-migration-coordinate-rebase.md): V4 migrations are `027` through `032`, all later fixtures are schema 32, and historical migrations `001` through `026` remain immutable.

## Freeze contents

- [Architecture and dependency boundaries](architecture.md)
- [Exact schema/DDL contract](schema-contract.md)
- [MCP tool contract](tool-contract.md) and [machine-readable delta](tool-contract.json)
- [Machine-readable V4 response schemas](contracts/v4-response-schemas.json)
- [Feature flags](feature-flags.md)
- [Recall ranking](recall-ranking.md)
- [Lifecycle policy](lifecycle-policy.md)
- [API compatibility](api-compatibility.md)
- [Threat model delta](threat-model.md)
- [Export/import and DR](export-dr-contract.md)
- [Exhaustive schema-32 export table policy](export-table-policy.json)
- [Exact schema-32 export column contract](export-schema-columns.json)
- [V4 observability catalog](metrics-catalog.md)
- [Offline export/import runbook](runbooks/export-import.md)
- [Backup/restore rehearsal](runbooks/backup-restore.md)
- [Immutable image contract](runbooks/immutable-image.md)
- [Rollout DAG](rollout-dag.md)
- [Phase/file ownership](ownership.md)
- [Benchmark protocol](benchmark-protocol.json), [frozen corpus specification](benchmark-corpus-spec.json), [case schema](contracts/v4-benchmark-case.schema.json), and [performance budgets](performance-budgets.json)
- [Traceability map](traceability.json)
- [Specification reconciliation](spec-reconciliation.md)
- [Open questions boundary](open-questions.md)

The ten canonical architecture decision paths are exactly `docs/decisions/ADR-V4-001.md` through `ADR-V4-010.md`; the coordinate amendment remains `ADR-V4-0001-migration-coordinate-rebase.md`. The generated current/proposed MCP snapshots live under `contracts/` and are verified by `scripts/v4-contract-snapshot.ts`. `scripts/v4-traceability-check.ts` validates required artifacts, actual local-link count, JSON/ref resolution, per-tool authorization, exhaustive export table classification, corpus identity, ADR status/path inventory, traceability IDs, migration coordinates, retention behavior, and unresolved-marker absence.

No file in P01 implements V4 runtime behavior or applies schema/data changes.
