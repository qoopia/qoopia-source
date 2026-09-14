# Recall ranking and explain contract

## Baseline bypass

When V4 relation/latest/explain/lifecycle/feedback flags are all off, the existing `src/services/recall.ts` path is executed without V4 candidate expansion, score multiplication, tie-break substitution, trace writes, or reinforcement writes. Result ordering and baseline response fields must be byte-identical for the same fixture/database/config.

## Enabled pipeline

Before retrieval, normalize the three history controls exactly:

- existing `include_archived` defaults to `false` and controls whether archived notes may be returned. It does not block an authorized superseded row from acting as an internal bridge to a visible active head when effective latest-only is enabled;
- `include_history` defaults to `false`; `true` requires `include_archived=true`, otherwise return `INVALID_ARGUMENT`;
- when `include_history=true`, explicit `latest_only=true` is `INVALID_ARGUMENT`, while omitted or false `latest_only` resolves to effective `false` even if `QOOPIA_V4_LATEST_ONLY` is enabled;
- when `include_history=false`, effective `latest_only` is the explicit value when supplied, otherwise the `QOOPIA_V4_LATEST_ONLY` flag value;
- `include_archived=true` never implies `include_history=true`. With effective latest-only, an archived superseded row remains omitted; an archived active head is eligible. With latest-only disabled and history disabled, existing include-archived behavior is preserved and no relation-history penalty is invented.

The enabled pipeline is:

1. Apply workspace/private/type/project authorization before diagnostics. Apply archive return eligibility next. With effective latest-only, an authorized archived row that is the target of a supersede edge may remain only as a non-returnable bridge candidate; it can trigger component expansion but cannot appear in results, explain, or traces unless `include_archived=true` and history mode permits it. Other archive-ineligible rows are removed.
2. Retrieve at most 50 candidates per existing FTS5/vector channel.
3. Inside a source, compute `inner_rrf = Σ 1/(60 + channel_rank)`, with ranks starting at 1.
4. Optional rerank reorders only the authorized bounded direct source list. On timeout/error the RRF order is retained and a bounded fallback reason is recorded. Assign unique `post_rerank_rank` values `1..N` to this direct list before relation expansion.
5. For each visible note hit, expand its full visible `supersedes` component before final top-k. Expansion is capped at 1,000 nodes and 1,000 edges per component; exceeding either returns `RELATION_GRAPH_LIMIT` rather than a potentially stale result.
6. Inject every visible active head. Per source, a head's `anchor_rank` is the minimum `post_rerank_rank` among itself when directly retrieved and all visible matched ancestors that caused its expansion. A head absent from direct retrieval also inherits the maximum `inner_rrf` of those ancestors, has `rerank_score=null`, and receives reason `head_inherited_from_superseded`. A directly retrieved head keeps the greater of its own and inherited `inner_rrf` values.
7. Do not remove a superseded hit until a visible active head or explicit conflict marker has been inserted. Multiple active heads are preserved and marked conflict.
8. Rebuild each source list after injection. Sort by `anchor_rank ASC`; at the same anchor put active heads before superseded/history rows; then use note `updated_at_ms DESC` and `id ASC`. Assign new dense `source_rank=1..M`. Thus reranking is never re-run over injected rows and an injected head deterministically occupies the best post-rerank position that led to it. Deduplication of a head reached through multiple ancestors keeps the best anchor and maximum inherited `inner_rrf`.
9. Perform global source RRF exactly as the baseline: `global_rrf = 1/(60 + source_rank)`. Cross-source ties use `entity`, `notes`, `activity`, `sessions` priority only before V4 multipliers.
10. Normalize `retrieval_score = 61 × global_rrf`.
11. Compute final score and sort once.

## Exact final score

```text
relation_factor = 0.90 for a superseded row returned only because include_history=true
relation_factor = 0.95 for each visible active head in an unresolved multi-head conflict
relation_factor = 1.00 otherwise

governance_factor = 1.05 when note.project_id resolves to a visible project note whose metadata status is active
governance_factor = 1.00 otherwise

lifecycle_factor = lifecycle-policy result for notes when enabled, otherwise 1.00

final_score = retrieval_score × relation_factor × governance_factor × lifecycle_factor
```

The factors are applied once. The owner-pin boost exists only in `lifecycle_factor`; it is not multiplied a second time as governance. Non-note results use relation, governance, and lifecycle factors of `1.00`.

## Determinism

Final ordering is:

1. unrounded `final_score DESC`;
2. `updated_at_ms DESC` for notes, otherwise parsed `created_at DESC`;
3. `id ASC` by Unicode code-point order.

Serialized score components are rounded to six decimal places. The trace records the pipeline version, source ranks, available channel scores, factor values, final rank, and bounded reason codes used by the same calculation. It never records the raw query or a candidate filtered by authorization.

P04 must freeze fixtures for every valid/invalid history-control combination and for rerank success/fallback where a matched stale row injects one and multiple heads. The expected source ranks and final ranks are part of the fixture, not reviewer judgment.
