-- Rollback for 048-read-path-indexes.sql: drops its indexes.
DROP INDEX IF EXISTS idx_notes_project_fk;
DROP INDEX IF EXISTS idx_files_ws_folder_created;
DROP INDEX IF EXISTS idx_files_ws_created;
DROP INDEX IF EXISTS idx_agent_wake_events_message;
DROP INDEX IF EXISTS idx_agent_comm_messages_inbox;
DROP INDEX IF EXISTS idx_session_messages_agent;

DELETE FROM schema_versions WHERE version = 48;
