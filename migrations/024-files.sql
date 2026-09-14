-- 024-files.sql — owner-uploaded files (dashboard) readable by fleet agents (MCP).
-- Bytes stored inline as BLOB (no extra volume; included in DB backups).

CREATE TABLE IF NOT EXISTS files (
  id                   TEXT PRIMARY KEY,                                    -- ULID
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_agent_id       TEXT NOT NULL REFERENCES agents(id),                 -- folder owner (Askhat)
  folder               TEXT NOT NULL DEFAULT 'inbox',
  filename             TEXT NOT NULL,
  mime                 TEXT NOT NULL DEFAULT 'application/octet-stream',
  size                 INTEGER NOT NULL,
  sha256               TEXT NOT NULL,
  content              BLOB NOT NULL,
  text_excerpt         TEXT,                                               -- extracted text (md/txt/docx/pdf), nullable
  uploaded_by_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, folder, filename)
);
CREATE INDEX IF NOT EXISTS idx_files_workspace_folder ON files(workspace_id, folder);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(workspace_id, owner_agent_id);

INSERT INTO schema_versions (version, description) VALUES (24, '024-files.sql');
