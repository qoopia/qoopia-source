-- Stable per-connection identities and client-call evidence, kept beside local memory.
-- Null resource is reserved for pre-migration grants; all newly issued tokens bind an audience.
ALTER TABLE oauth_tokens ADD COLUMN resource TEXT;
ALTER TABLE consent_tickets ADD COLUMN resource TEXT;
CREATE TABLE client_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES agents(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  surface TEXT NOT NULL CHECK(surface IN ('chatgpt_web','chatgpt_desktop','claude_web','claude_desktop','codex','claude_code')),
  access_mode TEXT NOT NULL CHECK(access_mode IN ('read','read_write')),
  request_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_client' CHECK(state IN ('awaiting_client','verified','revoked')),
  challenge_hash TEXT NOT NULL,
  challenge_expires_at TEXT NOT NULL,
  oauth_client_id TEXT REFERENCES oauth_clients(id),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(owner_id, request_key),
  UNIQUE(agent_id)
);
CREATE INDEX client_connections_workspace ON client_connections(workspace_id, owner_id);
