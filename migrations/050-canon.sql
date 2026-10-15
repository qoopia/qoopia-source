-- Canon: short rules the owner and the agents keep, loaded into context by the server on their
-- own (brief, every user turn through the memory hook, AgentComm wakes) instead of waiting for a
-- prompt to ask. A canon belongs to the whole workspace, one agent or one project; it is either
-- always loaded or chosen per turn by its triggers and text. A changed rule supersedes the old
-- one, so two contradicting canons are never active together. canon_applications records which
-- canons reached which turn, so "it was not loaded" and "it was ignored" can be told apart.
-- compatibility: schema-49 builds ignore the three tables and serve no canon; nothing they read
--   or write changes.
-- recovery: restore the pre-migration backup, or run rollback/050 (drops the canon tables; the
--   rule notes a canon was imported from stay untouched in notes).
-- data-after-upgrade: no existing row changes; the tables start empty. Rule notes are imported
--   only by `qoopia canon import-rules --commit`, which leaves the notes themselves as they are.
CREATE TABLE IF NOT EXISTS canons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'agent', 'project')),
  agent_id TEXT REFERENCES agents(id),
  project_id TEXT REFERENCES notes(id),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  mode TEXT NOT NULL CHECK (mode IN ('always', 'contextual')),
  triggers TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(triggers)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retired')),
  supersedes_id TEXT REFERENCES canons(id),
  superseded_by TEXT REFERENCES canons(id),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'rule_import', 'dreaming', 'dashboard')),
  source_note_id TEXT,
  created_by TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_applied_at TEXT,
  applied_count INTEGER NOT NULL DEFAULT 0,
  CHECK ((scope = 'agent') = (agent_id IS NOT NULL)),
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_canons_active ON canons(workspace_id, status, scope, mode);
CREATE INDEX IF NOT EXISTS idx_canons_agent ON canons(agent_id, status) WHERE agent_id IS NOT NULL;
-- One canon per imported rule note, so a repeated import never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canons_source_note ON canons(workspace_id, source_note_id) WHERE source_note_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS canons_fts USING fts5(
  text, triggers, content='canons', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS canons_ai AFTER INSERT ON canons BEGIN
  INSERT INTO canons_fts(rowid, text, triggers) VALUES (new.rowid, new.text, new.triggers);
END;
CREATE TRIGGER IF NOT EXISTS canons_ad AFTER DELETE ON canons BEGIN
  INSERT INTO canons_fts(canons_fts, rowid, text, triggers) VALUES ('delete', old.rowid, old.text, old.triggers);
END;
CREATE TRIGGER IF NOT EXISTS canons_au AFTER UPDATE OF text, triggers ON canons BEGIN
  INSERT INTO canons_fts(canons_fts, rowid, text, triggers) VALUES ('delete', old.rowid, old.text, old.triggers);
  INSERT INTO canons_fts(rowid, text, triggers) VALUES (new.rowid, new.text, new.triggers);
END;

-- The vector of a canon's text for the semantic channel; rebuilt when the text or model changes.
CREATE TABLE IF NOT EXISTS canon_embeddings (
  canon_id TEXT PRIMARY KEY REFERENCES canons(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  text_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canon_embeddings_workspace ON canon_embeddings(workspace_id, model);

CREATE TABLE IF NOT EXISTS canon_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  canon_id TEXT NOT NULL REFERENCES canons(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  surface TEXT NOT NULL CHECK (surface IN ('session_start', 'prompt', 'brief', 'wake', 'match')),
  reason TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canon_applications_canon ON canon_applications(canon_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_canon_applications_agent ON canon_applications(workspace_id, agent_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_canon_applications_age ON canon_applications(applied_at);
-- Whether a session already received its always canons (a first prompt after a silent start).
CREATE INDEX IF NOT EXISTS idx_canon_applications_session ON canon_applications(agent_id, session_id) WHERE session_id IS NOT NULL;
