-- Rollback for 019-sync-conflict-queue.sql.
-- The migration is additive (new table only) — rollback drops the table and
-- its indices, then removes the schema_versions row.

DROP INDEX IF EXISTS idx_sync_conflict_queue_row;
DROP INDEX IF EXISTS idx_sync_conflict_queue_status_created;
DROP TABLE IF EXISTS sync_conflict_queue;
DELETE FROM schema_versions WHERE version = 19;
