-- compatibility: schema-51 readers ignore the nullable key-age column and the triggers.
-- recovery: restore the pre-migration backup before running schema-51 software.
-- data-after-upgrade: old dates remain unknown; new and rotated keys receive an issue date.
-- Existing key issue dates are unknown. Only new keys acquire a date.
ALTER TABLE agents ADD COLUMN api_key_issued_at TEXT;
CREATE TRIGGER agent_key_issued_insert AFTER INSERT ON agents
WHEN NEW.api_key_issued_at IS NULL
BEGIN
  UPDATE agents SET api_key_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
CREATE TRIGGER agent_key_issued_rotate AFTER UPDATE OF api_key_hash ON agents
WHEN NEW.api_key_hash != OLD.api_key_hash
BEGIN
  UPDATE agents SET api_key_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
