CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_comm_messages_id_workspace
  ON agent_comm_messages(id, workspace_id);

CREATE TABLE IF NOT EXISTS agent_comm_delivery_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL CHECK (length(consumer_id) BETWEEN 1 AND 200),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'leased', 'delivered', 'failed', 'dead_letter'
  )),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) <= 200),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 200),
  transport_provider TEXT CHECK (transport_provider IS NULL OR length(transport_provider) <= 100),
  transport_message_id TEXT CHECK (transport_message_id IS NULL OR length(transport_message_id) <= 512),
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, message_id, consumer_id),
  FOREIGN KEY (message_id, workspace_id)
    REFERENCES agent_comm_messages(id, workspace_id) ON DELETE RESTRICT,
  CHECK ((state = 'delivered' AND delivered_at IS NOT NULL) OR
         (state <> 'delivered' AND delivered_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_comm_delivery_receipts_due
  ON agent_comm_delivery_receipts(state, lease_expires_at, created_at)
  WHERE state IN ('pending', 'leased', 'failed');
CREATE INDEX IF NOT EXISTS idx_agent_comm_delivery_receipts_message
  ON agent_comm_delivery_receipts(workspace_id, message_id, state);

INSERT INTO schema_versions (version, description)
  VALUES (32, '032-agentcomm-delivery-receipts.sql');
