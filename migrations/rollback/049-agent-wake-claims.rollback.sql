-- Rollback for 049-agent-wake-claims.sql: drops the per-recipient wake lease table.
DROP TABLE IF EXISTS agent_wake_claims;

DELETE FROM schema_versions WHERE version = 49;
