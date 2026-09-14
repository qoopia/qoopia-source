-- Agent-to-agent communication pilot (Corsair Qoopia lab)
CREATE TABLE IF NOT EXISTS agent_comm_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_comm_sessions_workspace_status
  ON agent_comm_sessions(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_comm_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_comm_sessions(id) ON DELETE CASCADE,
  sender_agent_id TEXT NOT NULL REFERENCES agents(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK (kind IN ('request','ack','reply','status','system')),
  body TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  ack_required INTEGER NOT NULL DEFAULT 1 CHECK (ack_required IN (0,1)),
  acked_at TEXT,
  ack_status TEXT,
  parent_message_id TEXT REFERENCES agent_comm_messages(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_comm_messages_recipient
  ON agent_comm_messages(workspace_id, recipient_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_comm_messages_session
  ON agent_comm_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_agent_comm_messages_unacked
  ON agent_comm_messages(workspace_id, recipient_agent_id, acked_at, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_wake_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_agent_id TEXT NOT NULL REFERENCES agents(id),
  session_id TEXT NOT NULL REFERENCES agent_comm_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES agent_comm_messages(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'qoopia',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','failed','ignored')),
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_wake_events_target_status
  ON agent_wake_events(workspace_id, target_agent_id, status, created_at DESC);
