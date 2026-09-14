-- Rollback for migration 015-recall-log.sql.
-- The migration is additive (new table only), so rollback drops the
-- table + its indices and removes the schema_versions row.
--
-- Operators run this by hand when needed; the standard `migrate` runner
-- does not invoke this file. Lives under migrations/rollback/ per the
-- Wave 1A convention (forward migrations and rollbacks must NOT share a
-- numeric prefix in the same dir — the runner's alphabetic sort would
-- silently substitute the rollback for the forward on first run).

DROP INDEX IF EXISTS idx_recall_log_caller_agent_created;
DROP INDEX IF EXISTS idx_recall_log_created_at;
DROP TABLE IF EXISTS recall_log;
DELETE FROM schema_versions WHERE version = 15;
