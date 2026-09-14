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
