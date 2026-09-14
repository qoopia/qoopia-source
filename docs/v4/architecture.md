# V4 architecture and module boundaries

## Principles

Qoopia remains the canonical source of truth. Authorization is workspace/private-first. New state is additive and feature-gated. Canonical notes are written only by the existing note service after an explicit authorized action. Delivery acceleration, ranking metadata, diagnostics, export artifacts, and external references never replace their canonical ledgers.

## Runtime dependency graph

```mermaid
flowchart TD
  C[Native MCP / HTTP / dashboard / SDK] --> T[Transport and authentication]
  T --> G[Risk, OAuth scope, instance-role, workspace/private gates]
  G --> M[V4 MCP and dashboard adapters]
  M --> R[Relations and provenance]
  M --> X[Extraction review]
  M --> Q[Recall orchestrator]
  M --> A[AgentComm ledger and receipts]
  M --> E[Export/import plan]
  X --> N[Existing canonical note service]
  R --> N
  Q --> R
  Q --> L[Lifecycle and feedback]
  Q --> P[Privacy-safe traces]
  A --> W[Optional wake / transport]
  E --> B[Backup / manifest / restore services]
  R --> D[(SQLite schema 32)]
  X --> D
  Q --> D
  L --> D
  P --> D
  A --> D
  E --> D
  N --> D
  D --> O[Post-commit activity / optional outbox]
```

Dependencies point inward: transport adapters may call domain services; domain services may call persistence and the existing canonical note service; persistence never calls transport. External delivery and event outbox run after the owning transaction commits.

## Bounded contexts

| Context | Primary implementation boundary | Required invariant |
|---|---|---|
| Relations | `src/services/note-relations.ts` | composite workspace FK, acyclic supersede graph, explicit multiple heads |
| Provenance | `src/services/provenance.ts` | hash-only evidence and source ACL re-check |
| Lifecycle | `src/services/memory-lifecycle.ts` | stored counters/pin only; caller-relative confidence derived from visible provenance; protected records never decay negatively |
| Extraction | `src/services/extraction.ts` | proposal-only; canonical write only after explicit review |
| Recall | existing orchestrator plus `src/services/recall/**` | baseline bypass when flags off; authorized head expansion before top-k |
| Traces/feedback | dedicated services | no raw query or hidden candidate; 30-day trace detach/delete transaction preserves durable feedback |
| AgentComm receipts | `src/services/agent-delivery.ts` | ledger first; idempotent consumer lease; wake not correctness |
| Export/DR | `src/services/export.ts` and V4 scripts | complete signed bundle, plan first, no secret-bearing response |
| Event outbox | `src/services/event-outbox.ts` | post-commit, metadata only, SSRF-safe delivery |
| UI | existing dashboard modules | service ACL parity, no independent authorization logic |

## Critical sequences

### Relation-aware recall

```mermaid
sequenceDiagram
  participant Caller
  participant Auth
  participant Recall
  participant Relations
  participant Trace
  Caller->>Auth: recall request
  Auth->>Recall: workspace + caller capabilities
  Recall->>Recall: authorized FTS/vector candidates
  Recall->>Relations: expand visible supersede components
  Relations-->>Recall: active heads / explicit conflicts
  Recall->>Recall: rank complete visible candidate set
  Recall->>Trace: visible IDs, hashes, scores only
  Recall-->>Caller: top-k + optional explain/trace ID
  Recall->>Recall: deferred reinforcement for later calls
```

### Reviewed extraction

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running
  running --> review
  running --> failed
  running --> cancelled
  review --> accepted: explicit accept
  review --> edited: explicit edit
  review --> rejected: explicit reject
  review --> expired
  accepted --> [*]
  edited --> [*]
  rejected --> [*]
  expired --> [*]
  failed --> [*]
  cancelled --> [*]
```

Only transitions to `accepted` or `edited` invoke the existing canonical note service, within an auditable idempotent transaction.

## Compatibility boundary

Schema 32 is additive. V3 code ignores the new tables. With all V4 flags off, V4 executes the baseline service paths and retains baseline required fields/defaults/envelopes. New tool discovery is additive. The compatibility overlay remains default-off and outside V4 SDK/CLI/docs.
