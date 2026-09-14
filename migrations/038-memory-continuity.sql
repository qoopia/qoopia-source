-- Rebuildable passage index. Original notes and historical vectors remain intact.
CREATE TABLE note_embedding_chunks (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_no INTEGER NOT NULL CHECK(chunk_no >= 0),
  start_char INTEGER NOT NULL CHECK(start_char >= 0),
  end_char INTEGER NOT NULL CHECK(end_char > start_char),
  embedding BLOB NOT NULL,
  PRIMARY KEY(note_id,chunk_no)
);
-- One evolving checkpoint per agent/session. Native session IDs are namespaced
-- by their runtime; concurrent conversations never compete for one checkpoint.
CREATE UNIQUE INDEX notes_continuity_session ON notes(workspace_id,agent_id,session_id)
  WHERE source='qoopia-continuity' AND deleted_at IS NULL;

INSERT INTO schema_versions(version,description) VALUES(38,'038-memory-continuity.sql');
