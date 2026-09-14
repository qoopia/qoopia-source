-- Phase 3 / WS-7: durable AgentComm idempotency and wake delivery state.

ALTER TABLE agent_comm_sessions ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_agent_comm_sessions_idempotency
  ON agent_comm_sessions(workspace_id, created_by_agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE agent_comm_messages ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_agent_comm_messages_idempotency
  ON agent_comm_messages(workspace_id, sender_agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE agent_wake_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_wake_events ADD COLUMN last_attempt_at TEXT;
ALTER TABLE agent_wake_events ADD COLUMN next_attempt_at TEXT;
ALTER TABLE agent_wake_events ADD COLUMN last_error TEXT;

CREATE INDEX idx_agent_wake_events_due
  ON agent_wake_events(status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'failed');

INSERT INTO schema_versions (version, description)
  VALUES (26, 'Phase 3 AgentComm idempotency and durable wake lifecycle');
