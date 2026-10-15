-- Indexes for paths that scanned whole growing tables, and removal of indexes that
-- duplicate another one (audit 5.0.21, A1-07..A1-10).
-- compatibility: the schema version guard refuses older builds on this schema.
-- recovery: restore the pre-migration backup, or run rollback/051 (drops the new
--   indexes and recreates the removed ones).
-- data-after-upgrade: no row added, changed or removed.

-- A1-07: Telegram delivery reconciles by run every second per owner, and a finished
-- run updates its inbox row by run_id: both scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_qoopia_telegram_outbox_run
  ON qoopia_telegram_outbox(run_id, generation);
CREATE INDEX IF NOT EXISTS idx_qoopia_telegram_inbox_run
  ON qoopia_telegram_inbox(run_id);

-- A1-08: skill_get looks up a skill's last self-reported test in the append-only
-- authority_events (event_seq is the rowid, so the index also gives its order).
CREATE INDEX IF NOT EXISTS idx_authority_events_subject
  ON authority_events(workspace_id, subject_id, kind);

-- A1-10: the memory worker runs every 5 s and selects each agent's sessions by
-- last_active; idx_sessions_agent made it read every session of the agent.
CREATE INDEX IF NOT EXISTS idx_sessions_agent_active
  ON sessions(agent_id, last_active);

-- A1-09: each index below repeats the columns of another index on its table, or
-- is a prefix of one, and only slowed every write.
DROP INDEX IF EXISTS idx_sessions_agent;          -- prefix of idx_sessions_agent_active
DROP INDEX IF EXISTS idx_sessions_workspace;      -- prefix of idx_sessions_active(workspace_id, last_active)
DROP INDEX IF EXISTS ux_agents_id_workspace;      -- same UNIQUE(id, workspace_id) as agents_workspace_identity
DROP INDEX IF EXISTS idx_entity_pages_slug;       -- same as the UNIQUE(workspace_id, slug) constraint
DROP INDEX IF EXISTS idx_recall_trace_items_trace; -- same as the UNIQUE(workspace_id, trace_id, final_rank) constraint
DROP INDEX IF EXISTS idx_notes_workspace;         -- prefix of idx_notes_known_ms and idx_notes_visibility_owner
DROP INDEX IF EXISTS idx_notes_project;           -- partial copy of idx_notes_project_fk(project_id)
DROP INDEX IF EXISTS idx_files_workspace_folder;  -- prefix of UNIQUE(workspace_id, folder, filename)
