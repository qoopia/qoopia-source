-- migrations/001-initial-schema.sql
-- Qoopia V3.0 initial schema
-- Created: 2026-04-11
-- Source: docs/20-to-be/01-schema.md

-- ============================================================
-- GROUP A: Identity & tenancy
-- ============================================================

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  api_key_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  api_key_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_agents_workspace ON agents(workspace_id);
CREATE INDEX idx_agents_api_key ON agents(api_key_hash) WHERE active = 1;

-- ============================================================
-- GROUP B: Universal notes
-- ============================================================

CREATE TABLE notes (
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_notes_workspace ON notes(workspace_id);
CREATE INDEX idx_notes_type ON notes(workspace_id, type) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_project ON notes(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_agent ON notes(agent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_created ON notes(workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_task_bound ON notes(task_bound_id) WHERE task_bound_id IS NOT NULL;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  text,
  content='notes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

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

-- ============================================================
-- GROUP C: Session memory
-- ============================================================

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),
  title TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  task_bound_id TEXT REFERENCES notes(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_active ON sessions(workspace_id, last_active DESC);
CREATE INDEX idx_sessions_task_bound ON sessions(task_bound_id) WHERE task_bound_id IS NOT NULL;

CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  token_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_session_messages_session ON session_messages(session_id, id);
CREATE INDEX idx_session_messages_workspace ON session_messages(workspace_id, created_at DESC);

CREATE VIRTUAL TABLE session_messages_fts USING fts5(
  content,
  content='session_messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
  INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER session_messages_ad AFTER DELETE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  msg_start_id INTEGER NOT NULL,
  msg_end_id INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  token_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_summaries_session ON summaries(session_id, msg_start_id);
CREATE INDEX idx_summaries_workspace ON summaries(workspace_id, created_at DESC);

-- ============================================================
-- GROUP D: Activity log
-- ============================================================

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  project_id TEXT REFERENCES notes(id),
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_activity_workspace ON activity(workspace_id, created_at DESC);
CREATE INDEX idx_activity_entity ON activity(entity_type, entity_id);
CREATE INDEX idx_activity_project ON activity(project_id, created_at DESC) WHERE project_id IS NOT NULL;

-- ============================================================
-- GROUP E: OAuth
-- ============================================================

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  client_secret_hash TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh', 'code')),
  code_challenge TEXT,
  code_challenge_method TEXT,
  redirect_uri TEXT,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_oauth_tokens_client ON oauth_tokens(client_id) WHERE revoked = 0;
CREATE INDEX idx_oauth_tokens_agent ON oauth_tokens(agent_id) WHERE revoked = 0;
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at) WHERE revoked = 0;

-- ============================================================
-- GROUP F: System
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  response TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================
-- Seed: record this migration
-- ============================================================

INSERT INTO schema_versions (version, description) VALUES
  (1, 'Initial V3.0 schema: universal notes, sessions, summaries, simplified OAuth');
