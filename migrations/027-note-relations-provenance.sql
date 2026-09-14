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
