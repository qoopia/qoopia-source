-- Add Muse Code and Grok Bot without making every future client require a table rebuild.
-- compatibility: schema-46 builds cannot write the new surfaces and must not run after upgrade.
-- recovery: restore the pre-migration backup or forward-fix; do not run an older writer on this schema.
-- data-after-upgrade: copy every existing connection, including its OAuth audience origin,
--   challenge, grant reference, verification evidence and revocation state unchanged.
CREATE TABLE client_connections_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES agents(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  surface TEXT NOT NULL CHECK(length(surface)>0),
  access_mode TEXT NOT NULL CHECK(access_mode IN ('read','read_write')),
  request_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_client' CHECK(state IN ('awaiting_client','verified','revoked')),
  challenge_hash TEXT NOT NULL,
  challenge_expires_at TEXT NOT NULL,
  oauth_client_id TEXT REFERENCES oauth_clients(id),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  origin TEXT NOT NULL DEFAULT '',
  UNIQUE(owner_id, request_key),
  UNIQUE(agent_id)
);
INSERT INTO client_connections_next
  SELECT id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,
    challenge_hash,challenge_expires_at,oauth_client_id,verified_at,created_at,revoked_at,origin
  FROM client_connections;
DROP TABLE client_connections;
ALTER TABLE client_connections_next RENAME TO client_connections;
CREATE INDEX client_connections_workspace ON client_connections(workspace_id, owner_id);
