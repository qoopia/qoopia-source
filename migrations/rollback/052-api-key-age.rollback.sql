DROP TRIGGER IF EXISTS agent_key_issued_insert;
DROP TRIGGER IF EXISTS agent_key_issued_rotate;
ALTER TABLE agents DROP COLUMN api_key_issued_at;
