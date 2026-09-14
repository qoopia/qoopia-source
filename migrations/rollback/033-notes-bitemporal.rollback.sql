-- 033-notes-bitemporal.rollback.sql
--
-- ТЗ §5.5. Порядок: индексы -> триггеры -> provenance -> остатки staging ->
-- колонки `notes` -> запись schema_versions.
--
-- Предусловия (owner GO, Class B): флаг QOOPIA_V4_BITEMPORAL выключен,
-- предыдущий образ пересоздан, verified backup `v4-backup.ts --verify`.
--
-- `notes.metadata` миграцией 033 не менялась, а новые колонки не
-- сериализуются при выключенном флаге (explicit-field, §16), поэтому после
-- этого отката Flag-OFF вывод байт-идентичен исходному.
--
-- `ALTER TABLE ... DROP COLUMN` требует SQLite >= 3.35.0. Проверьте
-- `SELECT sqlite_version();` перед запуском; на более старой сборке нужен
-- table-rebuild (CREATE TABLE notes_new ... / INSERT SELECT / DROP / RENAME)
-- вместо девяти DROP COLUMN ниже.

DROP INDEX IF EXISTS idx_notes_current_ws;
DROP INDEX IF EXISTS idx_notes_current_ws_type;
DROP INDEX IF EXISTS idx_notes_valid_ms;
DROP INDEX IF EXISTS idx_notes_known_ms;
DROP INDEX IF EXISTS idx_notes_subject_valid;
DROP INDEX IF EXISTS idx_notes_supersedes_id;

DROP TRIGGER IF EXISTS ntp_ws_consistency_ins;
DROP TRIGGER IF EXISTS ntp_ws_consistency_upd;

DROP INDEX IF EXISTS idx_ntp_ws;
DROP TABLE IF EXISTS note_temporal_provenance;

DROP TABLE IF EXISTS mig033_linear_targets;
DROP TABLE IF EXISTS mig033_skipped;
DROP TABLE IF EXISTS mig033_staging_meta;

ALTER TABLE notes DROP COLUMN invalidated_at_ms;
ALTER TABLE notes DROP COLUMN valid_until_ms;
ALTER TABLE notes DROP COLUMN valid_from_ms;
ALTER TABLE notes DROP COLUMN created_at_ms;
ALTER TABLE notes DROP COLUMN supersedes_id;
ALTER TABLE notes DROP COLUMN subject_key;
ALTER TABLE notes DROP COLUMN invalidated_at;
ALTER TABLE notes DROP COLUMN valid_until;
ALTER TABLE notes DROP COLUMN valid_from;

DELETE FROM schema_versions WHERE version = 33;
