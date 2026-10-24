-- compatibility: schema-54 readers ignore the new table.
-- recovery: restore the pre-migration backup before returning to schema-54 software.
-- data-after-upgrade: claims made after the upgrade are lost on a return to schema 54; every claim expires by itself anyway.
-- «This work is taken»: a claim on a topic of a project, by one agent, until it expires or is released.
-- It locks nothing. Agents opening the project see it in the handoff and decide themselves [5.0.23].
CREATE TABLE work_claims (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  project TEXT NOT NULL,
  topic TEXT NOT NULL,
  session_id TEXT,
  note TEXT,
  claimed_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  released_at_ms INTEGER,
  released_by TEXT
);
CREATE INDEX work_claims_open ON work_claims(workspace_id, project, expires_at_ms) WHERE released_at_ms IS NULL;
