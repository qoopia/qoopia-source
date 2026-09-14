-- Rollback for migration 016-wake-slo-probes.sql.
-- The migration is additive (new table only), so rollback drops the
-- table + its indices and removes the schema_versions row.
--
-- Operators run this by hand when needed; the standard `migrate` runner
-- does not invoke this file.

DROP INDEX IF EXISTS idx_wake_slo_probes_error_class;
DROP INDEX IF EXISTS idx_wake_slo_probes_direction_started;
DROP TABLE IF EXISTS wake_slo_probes;
DELETE FROM schema_versions WHERE version = 16;
