# Schema 32 DDL contract

Accepted source schema: 26. Frozen target schema: 32. Historical migrations `001` through `026` are immutable. The SQL below is normative for P02; semantic changes require a new ADR and architecture review.

The migration runner provides first-run apply and subsequent no-op by `schema_versions`. Data backfill is not embedded in DDL. All timestamps are UTC ISO-8601 text with millisecond precision. JSON columns are validated. New note/agent/session/message references enforce workspace identity with composite foreign keys.

<a id="migration-027"></a>
## Migration 027 — `027-note-relations-provenance.sql`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_notes_id_workspace
  ON notes(id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_id_workspace
  ON agents(id, workspace_id);

CREATE TABLE IF NOT EXISTS note_relations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_note_id TEXT NOT NULL,
  target_note_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'supersedes', 'conflicts_with', 'supports', 'derived_from'
  )),
  created_by_agent_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND length(metadata) <= 16384),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, source_note_id, target_note_id, relation_type),
  CHECK (source_note_id <> target_note_id),
  CHECK (relation_type <> 'conflicts_with' OR source_note_id < target_note_id),
  FOREIGN KEY (source_note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_note_relations_source
  ON note_relations(workspace_id, source_note_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_note_relations_target
  ON note_relations(workspace_id, target_note_id, relation_type);

CREATE TABLE IF NOT EXISTS note_provenance (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  note_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'session_message', 'file', 'activity', 'note', 'agentcomm_message', 'manual'
  )),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 512),
  source_locator TEXT CHECK (source_locator IS NULL OR length(source_locator) <= 2048),
  source_hash TEXT NOT NULL CHECK (
    length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_by_agent_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND length(metadata) <= 16384),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, note_id, source_kind, source_id),
  FOREIGN KEY (note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_note_provenance_note
  ON note_provenance(workspace_id, note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_provenance_source
  ON note_provenance(workspace_id, source_kind, source_id);

INSERT INTO schema_versions (version, description)
  VALUES (27, '027-note-relations-provenance.sql');
```

`conflicts_with` callers normalize IDs before insert. Supersede cycle and active-head checks remain service/transaction invariants because SQLite cannot express graph acyclicity as a row check.

For a supersede edge, `source_note_id` is the new/current note and `target_note_id` is the prior note. In the same transaction the source mirrors `metadata.supersedes=target_note_id`; the target mirrors `metadata.superseded_by=source_note_id` and `metadata.status="archived"`. `supports`, `derived_from`, and `conflicts_with` do not invent a V3 metadata form. An active head is a component note that is not the target of any supersede edge. Malformed existing mirror values are reported by backfill and never silently rewritten.

<a id="migration-028"></a>
## Migration 028 — `028-memory-lifecycle.sql`

```sql
CREATE TABLE IF NOT EXISTS memory_lifecycle (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  note_id TEXT NOT NULL,
  last_recalled_at TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  last_confirmed_at TEXT,
  confirmation_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_count >= 0),
  owner_pinned INTEGER NOT NULL DEFAULT 0 CHECK (owner_pinned IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, note_id),
  FOREIGN KEY (note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_recalled
  ON memory_lifecycle(workspace_id, last_recalled_at);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_pinned
  ON memory_lifecycle(workspace_id, owner_pinned, last_confirmed_at DESC);

INSERT INTO schema_versions (version, description)
  VALUES (28, '028-memory-lifecycle.sql');
```

<a id="migration-029"></a>
## Migration 029 — `029-extraction-review.sql`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_id_workspace
  ON sessions(id, workspace_id);

CREATE TABLE IF NOT EXISTS extraction_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  source_start_id INTEGER NOT NULL CHECK (source_start_id > 0),
  source_end_id INTEGER NOT NULL CHECK (source_end_id >= source_start_id),
  source_range_hash TEXT NOT NULL CHECK (
    length(source_range_hash) = 64 AND source_range_hash NOT GLOB '*[^0-9a-f]*'
  ),
  extractor_version TEXT NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 100),
  prompt_hash TEXT NOT NULL CHECK (
    length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'review', 'completed', 'failed', 'cancelled'
  )),
  initiated_by_agent_id TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  UNIQUE (workspace_id, session_id, extractor_version, source_range_hash),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (session_id, workspace_id)
    REFERENCES sessions(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (initiated_by_agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_session
  ON extraction_runs(workspace_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_status
  ON extraction_runs(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS extraction_candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  proposed_text TEXT NOT NULL CHECK (length(proposed_text) BETWEEN 1 AND 16384),
  proposed_type TEXT NOT NULL CHECK (proposed_type IN (
    'note', 'task', 'deal', 'contact', 'finance', 'project',
    'memory', 'rule', 'knowledge', 'context', 'decision'
  )),
  proposed_tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(proposed_tags) AND length(proposed_tags) <= 16384),
  proposed_entities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(proposed_entities) AND length(proposed_entities) <= 16384),
  source_message_ids TEXT NOT NULL CHECK (json_valid(source_message_ids) AND length(source_message_ids) <= 16384),
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  dedup_note_id TEXT,
  conflict_note_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflict_note_ids) AND length(conflict_note_ids) <= 16384),
  risk_flags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(risk_flags) AND length(risk_flags) <= 4096),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'accepted', 'edited', 'rejected', 'expired', 'failed'
  )),
  accepted_note_id TEXT,
  reviewed_by_agent_id TEXT,
  reviewed_at TEXT,
  review_reason_code TEXT CHECK (review_reason_code IS NULL OR length(review_reason_code) <= 100),
  review_version INTEGER NOT NULL DEFAULT 0 CHECK (review_version >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (run_id, workspace_id)
    REFERENCES extraction_runs(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (dedup_note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (accepted_note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewed_by_agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE RESTRICT,
  CHECK ((status IN ('accepted', 'edited') AND accepted_note_id IS NOT NULL) OR
         (status NOT IN ('accepted', 'edited') AND accepted_note_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_extraction_candidates_run
  ON extraction_candidates(workspace_id, run_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_review
  ON extraction_candidates(workspace_id, status, updated_at DESC);

INSERT INTO schema_versions (version, description)
  VALUES (29, '029-extraction-review.sql');
```

The service verifies that every `source_message_ids` entry is inside the authorized run range and that JSON arrays contain only bounded scalar IDs/tags. SQL status plus `review_version` provides compare-and-swap review semantics.

The initiator or an owner/steward capability may reject. Accept/edit for ordinary note types requires the initiator or owner/steward capability; accept/edit of `rule`, `finance`, owner-approved `decision`, or legal-classified content requires owner/steward capability. `edit` requires `edited_text`; accept/reject forbids edit-only fields. All checks are from AuthContext and re-run inside the transaction.

<a id="migration-030"></a>
## Migration 030 — `030-recall-traces-feedback.sql`

```sql
CREATE TABLE IF NOT EXISTS recall_traces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  caller_agent_id TEXT NOT NULL,
  query_hash TEXT NOT NULL CHECK (
    length(query_hash) = 64 AND query_hash NOT GLOB '*[^0-9a-f]*'
  ),
  mode TEXT NOT NULL CHECK (length(mode) BETWEEN 1 AND 100),
  options TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options) AND length(options) <= 4096),
  pipeline_version TEXT NOT NULL CHECK (length(pipeline_version) BETWEEN 1 AND 100),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  result_count INTEGER NOT NULL CHECK (result_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (caller_agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_recall_traces_caller
  ON recall_traces(workspace_id, caller_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recall_traces_expiry
  ON recall_traces(expires_at);

CREATE TABLE IF NOT EXISTS recall_trace_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  trace_id TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK (result_kind IN (
    'note', 'entity', 'activity', 'session_message'
  )),
  result_id TEXT NOT NULL,
  note_id TEXT,
  source_channel TEXT NOT NULL CHECK (source_channel IN (
    'fts5', 'vector', 'both', 'activity_fts', 'session_fts'
  )),
  fts_rank INTEGER CHECK (fts_rank IS NULL OR fts_rank > 0),
  vector_rank INTEGER CHECK (vector_rank IS NULL OR vector_rank > 0),
  fts_score REAL,
  vector_score REAL,
  rrf_score REAL NOT NULL,
  rerank_score REAL,
  lifecycle_factor REAL NOT NULL DEFAULT 1.0 CHECK (lifecycle_factor BETWEEN 0.85 AND 1.15),
  governance_factor REAL NOT NULL DEFAULT 1.0 CHECK (governance_factor BETWEEN 1.0 AND 1.05),
  relation_factor REAL NOT NULL DEFAULT 1.0 CHECK (relation_factor BETWEEN 0.90 AND 1.0),
  final_score REAL NOT NULL,
  final_rank INTEGER NOT NULL CHECK (final_rank > 0),
  reason_codes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reason_codes) AND length(reason_codes) <= 4096),
  UNIQUE (workspace_id, trace_id, result_kind, result_id),
  UNIQUE (workspace_id, trace_id, final_rank),
  CHECK ((result_kind = 'note' AND note_id = result_id) OR
         (result_kind <> 'note' AND note_id IS NULL)),
  FOREIGN KEY (trace_id, workspace_id)
    REFERENCES recall_traces(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_recall_trace_items_trace
  ON recall_trace_items(workspace_id, trace_id, final_rank);

CREATE TABLE IF NOT EXISTS recall_feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  note_id TEXT NOT NULL,
  trace_id TEXT,
  actor_agent_id TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK (feedback IN (
    'helpful', 'not_helpful', 'stale', 'incorrect', 'confirm', 'pin', 'unpin'
  )),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) <= 100),
  reason_text TEXT CHECK (reason_text IS NULL OR length(reason_text) <= 500),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, actor_agent_id, idempotency_key),
  FOREIGN KEY (note_id, workspace_id)
    REFERENCES notes(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (trace_id, workspace_id)
    REFERENCES recall_traces(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_recall_feedback_note
  ON recall_feedback(workspace_id, note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recall_feedback_trace
  ON recall_feedback(workspace_id, trace_id)
  WHERE trace_id IS NOT NULL;

INSERT INTO schema_versions (version, description)
  VALUES (30, '030-recall-traces-feedback.sql');
```

Raw queries are absent by schema. `recall_feedback.trace_id` is deliberately nullable while its composite foreign key remains `ON DELETE RESTRICT`: feedback is durable canonical state, whereas traces are 30-day ephemeral diagnostics.

The only valid expiry algorithm is a bounded dry-run-first job using one `BEGIN IMMEDIATE` transaction per batch:

1. select at most 1,000 `recall_traces` whose `expires_at <= cutoff`, ordered by `expires_at ASC, id ASC`;
2. set `recall_feedback.trace_id = NULL` for exactly those `(workspace_id, trace_id)` pairs;
3. delete their `recall_trace_items`;
4. delete their `recall_traces`;
5. require `foreign_key_check` for the affected tables to return no rows, then commit; otherwise roll back the whole batch.

`BEGIN IMMEDIATE` serializes concurrent feedback insertion with the detach/delete batch. A feedback write that supplies `trace_id` must, in its own transaction, prove the trace is unexpired, belongs to the caller's workspace and caller identity, contains the visible `note_id`, and still exists at insert time. The retention job never deletes feedback or canonical notes. P02 must test: feedback survives expiry with a null trace reference; items and header disappear atomically; an injected failure after detach rolls back every step; a concurrent insert either commits before expiry and is detached or commits afterward and is rejected because the trace is gone/expired; and `PRAGMA foreign_key_check` remains empty.

<a id="migration-031"></a>
## Migration 031 — `031-event-outbox.sql`

```sql
CREATE TABLE IF NOT EXISTS memory_event_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'candidate_proposed', 'candidate_reviewed', 'note_superseded',
    'feedback_recorded', 'export_created', 'import_planned', 'conflict_detected'
  )),
  aggregate_kind TEXT NOT NULL CHECK (length(aggregate_kind) BETWEEN 1 AND 100),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 512),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384),
  destination_id TEXT CHECK (destination_id IS NULL OR length(destination_id) <= 200),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'leased', 'delivered', 'failed', 'dead_letter'
  )),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) <= 200),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 200),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT,
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((state = 'delivered' AND delivered_at IS NOT NULL) OR
         (state <> 'delivered' AND delivered_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_memory_event_outbox_due
  ON memory_event_outbox(state, next_attempt_at, created_at)
  WHERE state IN ('pending', 'failed', 'leased');
CREATE INDEX IF NOT EXISTS idx_memory_event_outbox_aggregate
  ON memory_event_outbox(workspace_id, aggregate_kind, aggregate_id, created_at);

INSERT INTO schema_versions (version, description)
  VALUES (31, '031-event-outbox.sql');
```

Payload policy permits IDs and bounded non-secret metadata only. Destination IDs resolve through sanctioned allowlisted configuration; URLs and credentials are not stored in rows.

<a id="migration-032"></a>
## Migration 032 — `032-agentcomm-delivery-receipts.sql`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_comm_messages_id_workspace
  ON agent_comm_messages(id, workspace_id);

CREATE TABLE IF NOT EXISTS agent_comm_delivery_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL CHECK (length(consumer_id) BETWEEN 1 AND 200),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'leased', 'delivered', 'failed', 'dead_letter'
  )),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) <= 200),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 200),
  transport_provider TEXT CHECK (transport_provider IS NULL OR length(transport_provider) <= 100),
  transport_message_id TEXT CHECK (transport_message_id IS NULL OR length(transport_message_id) <= 512),
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, message_id, consumer_id),
  FOREIGN KEY (message_id, workspace_id)
    REFERENCES agent_comm_messages(id, workspace_id) ON DELETE RESTRICT,
  CHECK ((state = 'delivered' AND delivered_at IS NOT NULL) OR
         (state <> 'delivered' AND delivered_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_comm_delivery_receipts_due
  ON agent_comm_delivery_receipts(state, lease_expires_at, created_at)
  WHERE state IN ('pending', 'leased', 'failed');
CREATE INDEX IF NOT EXISTS idx_agent_comm_delivery_receipts_message
  ON agent_comm_delivery_receipts(workspace_id, message_id, state);

INSERT INTO schema_versions (version, description)
  VALUES (32, '032-agentcomm-delivery-receipts.sql');
```

`consumer_id` is an opaque, configured consumer identity and is not inferred from a fleet name. Receipt rows never duplicate the AgentComm body.

## Backfill and verification contract

The separate backfill supports `--plan`, `--dry-run`, `--apply`, `--resume-after`, and `--json-report`; default is non-applying. It dual-reads old metadata and the new relation rows, proposes only conservative relations, and reports malformed references, orphans, cycles, and multiple heads without auto-repair. It preserves the legacy denominator and must prove 943/943 coverage or a larger owner-accepted manifest denominator.

Acceptance requires scratch `001→032`, fixture `026→032`, first/second/third migration-runner executions, forced-stop/resume logical-hash equality, foreign-key/integrity checks, V3 binary/client smoke on schema 32, and production-backup-clone rehearsal. Production apply remains P10 owner-GO gated.

## Response model summary

The machine-readable response contract is `docs/v4/contracts/v4-response-schemas.json`. The summaries below are non-normative navigation aids; MCP snapshots reference the JSON Schema `$id`, never Markdown anchors.

<a id="note_relation"></a>
`note_relation` contains `id`, `source_note_id`, `target_note_id`, `relation_type`, `created_by_agent_id`, parsed `metadata`, and `created_at`; workspace ID is not used as an authorization substitute.

<a id="extraction_run"></a>
`extraction_run` contains the run ID, session/range IDs, extractor version, status, counts, non-secret error code, and timestamps; prompt text and message bodies are absent.

<a id="extraction_run_response"></a>
`extraction_run_response` contains one `extraction_run`, authorized candidate rows, and an opaque next cursor. Candidate source references are opaque IDs; underlying private content requires its own authorization.

<a id="recall_trace_response"></a>
`recall_trace_response` contains the trace header, visible trace items, and an opaque next cursor. Raw query, hidden candidate IDs, and source bodies are absent.
