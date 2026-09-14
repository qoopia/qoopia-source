-- rollback 024-files.sql
DROP INDEX IF EXISTS idx_files_owner;
DROP INDEX IF EXISTS idx_files_workspace_folder;
DROP TABLE IF EXISTS files;
DELETE FROM schema_versions WHERE version = 24;
