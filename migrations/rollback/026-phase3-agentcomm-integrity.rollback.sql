DROP INDEX IF EXISTS idx_agent_wake_events_due;
DROP INDEX IF EXISTS idx_agent_comm_messages_idempotency;
DROP INDEX IF EXISTS idx_agent_comm_sessions_idempotency;

ALTER TABLE agent_wake_events DROP COLUMN last_error;
ALTER TABLE agent_wake_events DROP COLUMN next_attempt_at;
ALTER TABLE agent_wake_events DROP COLUMN last_attempt_at;
ALTER TABLE agent_wake_events DROP COLUMN attempt_count;
ALTER TABLE agent_comm_messages DROP COLUMN idempotency_key;
ALTER TABLE agent_comm_sessions DROP COLUMN idempotency_key;

DELETE FROM schema_versions WHERE version = 26;
