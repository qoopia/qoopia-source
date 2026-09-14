-- Rollback for 020-sync-applied-hashes.sql.
-- Additive migration — rollback drops the table + secondary index and removes
-- the schema_versions row.

DROP INDEX IF EXISTS idx_sync_applied_hashes_table_row;
DROP TABLE IF EXISTS sync_applied_hashes;
DELETE FROM schema_versions WHERE version = 20;
