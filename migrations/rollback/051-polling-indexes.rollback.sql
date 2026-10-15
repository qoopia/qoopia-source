-- Rollback for 051-polling-indexes.sql: drops its indexes and recreates the ones it removed.
DROP INDEX IF EXISTS idx_qoopia_telegram_outbox_run;
DROP INDEX IF EXISTS idx_qoopia_telegram_inbox_run;
DROP INDEX IF EXISTS idx_authority_events_subject;

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_id_workspace ON agents(id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_entity_pages_slug ON entity_pages(workspace_id, slug);
CREATE INDEX IF NOT EXISTS idx_recall_trace_items_trace ON recall_trace_items(workspace_id, trace_id, final_rank);
CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_workspace_folder ON files(workspace_id, folder);
DROP INDEX IF EXISTS idx_sessions_agent_active;

DELETE FROM schema_versions WHERE version = 51;
