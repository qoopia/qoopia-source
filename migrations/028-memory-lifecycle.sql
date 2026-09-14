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
