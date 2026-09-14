-- Rollback for 017-updated-at-ms.sql.
-- SQLite cannot DROP a column added by ALTER TABLE prior to 3.35; the standard
-- approach is the table-rebuild dance. We do it explicitly here so the rollback
-- is auditable. The rebuild preserves all existing rows + indices + triggers.
--
-- Lives under migrations/rollback/ per Wave 1A convention (forward migrations
-- and rollbacks must NOT share a numeric prefix in the same dir — the runner's
-- alphabetic sort would silently substitute the rollback for the forward on
-- first run).

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_notes_updated_at_ms;

CREATE TABLE notes_rollback_017 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  project_id TEXT REFERENCES notes(id),
  task_bound_id TEXT REFERENCES notes(id),
  session_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  tags TEXT NOT NULL DEFAULT '[]',
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  visibility TEXT NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('workspace', 'private'))
);

INSERT INTO notes_rollback_017
  (id, workspace_id, agent_id, type, text, metadata, project_id, task_bound_id,
   session_id, source, tags, deleted_at, created_at, updated_at, visibility)
SELECT id, workspace_id, agent_id, type, text, metadata, project_id, task_bound_id,
       session_id, source, tags, deleted_at, created_at, updated_at, visibility
  FROM notes;

DROP TABLE notes;
ALTER TABLE notes_rollback_017 RENAME TO notes;

CREATE INDEX idx_notes_workspace ON notes(workspace_id);
CREATE INDEX idx_notes_type ON notes(workspace_id, type) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_project ON notes(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_agent ON notes(agent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_created ON notes(workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_task_bound ON notes(task_bound_id) WHERE task_bound_id IS NOT NULL;
CREATE INDEX idx_notes_visibility_owner ON notes(workspace_id, visibility, agent_id);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER notes_embeddings_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_embeddings WHERE note_id = old.id;
END;

DELETE FROM schema_versions WHERE version = 17;

COMMIT;
