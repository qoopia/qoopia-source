# P01 specification reconciliation

Baseline inspected: `integration/v4@b6c169b9c72a2f983933610072b4909ef61261c3`, migrations `001` through `026`, current MCP modules, recall orchestrator, OAuth risk mapping, instance-role guard, and dashboard route surface.

## Normative precedence

For P02-P09 execution, precedence is: (1) accepted [ADR-V4-0001](../decisions/ADR-V4-0001-migration-coordinate-rebase.md), (2) accepted `ADR-V4-001.md` through `ADR-V4-010.md`, (3) `docs/v4/**` machine-readable contracts and this reconciliation, then (4) the copied source TZ. A lower layer cannot override a higher layer.

The committed copied TZ at `artifacts/v4/inputs/QOOPIA_V4_PROFESSIONAL_TZ.md` changed from the pre-fix handoff blob `11e510e0e140d88f8a8c22ad314012dde96f6d73` (SHA-256 `e8e04c89e45a8cafe4988631302a6ed27e307cf949849504aedfb5cc77c24f1d`) to operative blob `4fce830f1104707339f96da4e069eac7dfd504b3` (SHA-256 `8c7ea852b750613425c2803c7cf929a7a60456ee364fb89629567e1b74767bd4`). The exact `git diff --unified=4 870ec4f775b8e8e930478affaf4bd7909e80a015..f4b2e90f746dc2b0f830d7064d747bb528302f96 -- artifacts/v4/inputs/QOOPIA_V4_PROFESSIONAL_TZ.md` has `9` additions, `10` deletions, and the following eight contextual hunks—three semantic copied-input edits plus five residual coordinate fixes:

| Hunk | Diff header | Class | Exact mutation | Authority consumed |
|---|---|---|---|---|
| 1 | `@@ -492,12 +492,11 @@` | semantic | Removes the persisted `source_confidence REAL NULL` bullet; rewrites lifecycle confidence as a caller-relative maximum over ACL-visible provenance; narrows protected incident/runbook wording to metadata-classified active/open records. | Review `9f36a97e` lifecycle-confidence/incident finding; frozen lifecycle/schema contracts. |
| 2 | `@@ -617,9 +616,9 @@` | semantic | Replaces the underspecified `include_history` conflict sentence with the complete normalization: archive opt-in required, omitted latest-only resolves false, explicit true is rejected. | Review `9f36a97e` history/rerank finding; frozen recall/flag contracts. |
| 3 | `@@ -631,10 +630,10 @@` | semantic | Elevates `export_plan`, `export_bundle`, and `import_plan` to admin risk with full profile, `mcp:admin`, owner/steward, canonical-instance, and exact-workspace authorization; preserves `export_bundle` output constraints and separates the GO-gated non-MCP `import_apply` rule. | Review `9f36a97e` result/auth finding; frozen tool authorization contract. |
| 4 | `@@ -1013,9 +1012,9 @@` | coordinate | P03 input `schema-30 scratch fixture` → `schema-32 scratch fixture`. | Accepted ADR-V4-0001 migration-coordinate rebase. |
| 5 | `@@ -1043,9 +1042,9 @@` | coordinate | P04 input `schema-30 fixture` → `schema-32 fixture`. | Accepted ADR-V4-0001 migration-coordinate rebase. |
| 6 | `@@ -1105,9 +1104,9 @@` | coordinate | P06 input `P02 migration 030` → `P02 migration 032`. | Accepted ADR-V4-0001 migration-coordinate rebase. |
| 7 | `@@ -1135,9 +1134,9 @@` | coordinate | P07 input `synthetic schema-30 fixtures` → `synthetic schema-32 fixtures`. | Accepted ADR-V4-0001 migration-coordinate rebase. |
| 8 | `@@ -1167,9 +1166,9 @@` | coordinate | P08 input `schema-30 production-size clone` → `schema-32 production-size clone`. | Accepted ADR-V4-0001 migration-coordinate rebase. |

No other copied-TZ bytes changed. With zero context Git renders the adjacent deletion and rewrite inside hunk 1 as two raw change blocks; the eight-hunk accounting above uses the reviewer's contextual grouping and explicitly includes both mutations. Historical prose describing the migration-030 recall-trace table is not stale and remains valid.

## Resolved factual deltas

| Source wording | Accepted reality | Frozen resolution |
|---|---|---|
| Original V4 coordinates followed the older pre-stabilization plan | accepted baseline already owns migrations 25 and 26 | [ADR-V4-0001](../decisions/ADR-V4-0001-migration-coordinate-rebase.md) and [ADR-V4-007](../decisions/ADR-V4-007.md): only 027-032; target 32 |
| Several later phase inputs retained the former target fixture label | P02 now ends at schema 32 | every P03-P09 fixture and verification target is schema 32 |
| P06 input named the former trace migration for delivery receipts | delivery receipts are assigned to the final V4 migration | P06 consumes migration 032 |
| Export/import tools are public-contract work while service implementation belongs to P08 | P05 precedes P08 | P01/P05 freeze schemas; P08 receives only a narrow handler-binding exception guarded by contract diff |
| Trace item wording assumed every recall result is a note | baseline recall also returns entities, activity, and session messages | trace rows use generic result kind/ID and an optional note FK; only note rows receive relation/lifecycle factors |
| Bounded retrieval could filter a stale hit without retrieving its head | active head may not be a channel candidate | relation-aware recall expands the visible supersede component and injects active heads before final top-k |
| Tie-break wording used the text timestamp | schema 26 provides monotonic `updated_at_ms` | note tie-break uses `updated_at_ms DESC`, semantically representing latest update, then ID |

These are factual reconciliations, not scope expansion. No product question remains for P02-P09.
