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
