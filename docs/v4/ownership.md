# Phase ownership and shared-contract rules

| Phase | Exclusive implementation ownership | Frozen input/output |
|---|---|---|
| P01 | `docs/v4/**`, `docs/decisions/ADR-V4-*`, P01 snapshot/traceability scripts | architecture freeze hash |
| P02 | migrations `027`-`032`, `src/db/**`, V4 backfill/verify scripts, migration tests | schema 32 fixture and reports |
| P03 | relation/provenance/lifecycle/extraction services and domain tests | domain interfaces for P04/P05 |
| P04 | recall orchestrator/helpers, trace/feedback services, recall tests | internal recall API and score contract |
| P05 | V4 MCP schemas/domain handlers, CLI, SDKs, adapters, contract tests | public tool snapshot |
| P06 | AgentComm ledger/wake/delivery services and tests | receipt/fault contract |
| P07 | dashboard API/UI and tests | additive V4 route contract |
| P08 | security/observability, export/import/outbox, backup/DR/image/runbooks | signed format and recovery evidence |
| P09 | benchmark corpus/metrics/CI qualification | release qualification reports |

## Shared files

The main implementation agent is the only integrator. Shared files are edited sequentially. A phase may touch a prior-phase-owned contract only through a dedicated fix/review cycle.

One narrow exception resolves the frozen export dependency: P08 may bind implementations for `export_plan`, `export_bundle`, and `import_plan` in the P05 MCP adapter. The input schemas, machine-readable response schemas, `admin` risk classes, full-profile requirement, `mcp:admin` scope, owner/steward capability, canonical-instance restriction, AuthContext-workspace binding, names, and transaction rechecks cannot change; `scripts/v4-contract-snapshot.ts --check` and P05 contract tests must pass. Any contract diff reopens P05 review.

No implementation phase edits the architecture freeze silently. Any semantic change requires a new ADR, regenerated freeze manifest, and independent architecture review.
