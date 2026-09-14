-- Independent installations are peers, never local memory principals.
CREATE TABLE bridge_identities (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES agents(id),
  agent_id TEXT REFERENCES agents(id),
  peer_id TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE bridges (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  relay TEXT NOT NULL,
  owner_peer TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('creating','pending','active','left','removed')),
  roster_json TEXT,
  checked_at_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE bridge_materials (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('outgoing','received')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('note','file','skill')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  content BLOB NOT NULL,
  version TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES agents(id),
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE bridge_publications (
  workspace_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  auto_send INTEGER NOT NULL DEFAULT 0 CHECK(auto_send IN (0,1)),
  approved_by TEXT NOT NULL REFERENCES agents(id),
  approved_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,group_id,material_id),
  FOREIGN KEY(workspace_id,group_id) REFERENCES bridges(workspace_id,id),
  FOREIGN KEY(workspace_id,material_id) REFERENCES bridge_materials(workspace_id,id)
);
CREATE TABLE bridge_catalogues (
  workspace_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  items_json TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,group_id,peer_id),
  FOREIGN KEY(workspace_id,group_id) REFERENCES bridges(workspace_id,id)
);
CREATE TABLE bridge_requests (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('outgoing','incoming')),
  material_id TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requested','approved','skipped','received','cancelled')),
  decision_by TEXT REFERENCES agents(id),
  received_id TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,group_id) REFERENCES bridges(workspace_id,id)
);
CREATE TABLE bridge_outbox (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  to_peer TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL,
  packet TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','acknowledged','cancelled')),
  attempted_at_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,group_id) REFERENCES bridges(workspace_id,id)
);
CREATE INDEX bridge_outbox_pending ON bridge_outbox(state,attempted_at_ms);
CREATE TABLE bridge_seen (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,group_id) REFERENCES bridges(workspace_id,id)
);
CREATE TABLE bridge_invites (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,group_id) REFERENCES bridges(workspace_id,id)
);
CREATE TABLE bridge_controls (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('remove','leave','close','revoke-invite')),
  target TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done')),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,group_id) REFERENCES bridges(workspace_id,id)
);
