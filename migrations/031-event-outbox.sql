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
