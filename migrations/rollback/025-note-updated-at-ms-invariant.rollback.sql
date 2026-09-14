DROP TRIGGER IF EXISTS notes_updated_at_ms_after_legacy_update;
DROP TRIGGER IF EXISTS notes_updated_at_ms_after_insert;
DELETE FROM schema_versions WHERE version = 25;
