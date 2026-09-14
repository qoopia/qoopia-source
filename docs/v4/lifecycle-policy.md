# Memory lifecycle policy

Lifecycle is ranking metadata, not retention. It never deletes, archives, suppresses history, or changes note content.

## Eligibility and protection

A note is protected from negative decay when any condition is true:

1. `type` is `rule` or `finance`;
2. `owner_pinned=1`;
3. `type=decision` and its author resolves to agent type `owner`, or metadata contains a verified owner-approval reference;
4. parsed note metadata has the exact scalar pair `record_class="legal"`;
5. parsed note metadata has `record_class` equal to `incident` or `runbook` and `status` equal to `active` or `open`.

This list is exhaustive. Entity-page links, entity type, provenance kind, source prose, tags, and unreadable objects do not independently protect a note. Protection is evaluated from the authorized note row and lifecycle row, not names or free-text inference.

## Exact factor

Let:

- `age_days = max(0, (now - max(last_confirmed_at, last_recalled_at, note.updated_at)) / 86400s)`;
- `decay = 1.0` for protected notes, otherwise `0.85 + 0.15 × 2^(-age_days / 180)`;
- `reinforcement = min(0.10, 0.01 × log2(1 + recall_count) + 0.03 × confirmation_count)`;
- `caller_confidence = max(confidence)` across only those `note_provenance` rows whose underlying source object is visible to the current caller after source-kind authorization; it is null when none are visible;
- `confidence_adjustment = clamp((caller_confidence - 0.5) × 0.10, -0.05, 0.05)`, or `0` when `caller_confidence` is null.

Then:

```text
owner_pinned ? 1.15 : clamp(decay + reinforcement + confidence_adjustment, 0.85, 1.15)
```

The computation uses IEEE-754 double precision and rounds only serialized explain fields to six decimal places. Ordering uses the unrounded value.

## Updates and authorization

- Recall uses state committed before the call.
- Access reinforcement is queued after response formation and affects later calls only.
- `confirm` requires visibility plus normal write capability.
- `pin` and `unpin` require owner or steward capability and `mcp:write`; authorization is rechecked in the transaction.
- A failed reinforcement write does not fail or reorder the response.
- Counts are monotonic and non-negative; duplicate feedback is suppressed by idempotency key.
- Caller-relative confidence is derived inside the authorized recall read snapshot and is never persisted in `memory_lifecycle`, activity, outbox, or a shared cache. A cache key, if later introduced, must include workspace, caller authorization epoch, note ID, and provenance revision.
- Explain may return only the derived numeric adjustment and visible provenance IDs already authorized for that caller. A hidden high-confidence provenance row cannot affect score, ordering, reason codes, or trace data for a caller who cannot read its source.

P03/P04 must include two callers over the same note: one can see a low-confidence source only; the other can also see a hidden high-confidence source. Their factors must differ exactly as the visible maxima dictate, and neither response may reveal the other's inaccessible provenance.
