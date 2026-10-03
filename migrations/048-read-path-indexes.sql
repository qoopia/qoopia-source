-- Indexes for hot read paths that scanned whole tables (audit 2026-10-02, A4),
-- plus one correction of legacy updated_at_ms values.
-- compatibility: the schema version guard still refuses schema-47 builds.
-- recovery: restore the pre-migration backup, or run rollback/048 (drops the indexes;
--   the corrected updated_at_ms values stay, the old ones were wrong).
-- data-after-upgrade: no row added or removed; only legacy updated_at_ms values change.

-- F-271: per-agent session message count / last capture (dashboard agents poll).
CREATE INDEX IF NOT EXISTS idx_session_messages_agent
  ON session_messages(agent_id, workspace_id, created_at);

-- F-273: the cross-workspace inbox filters by recipient only; the wake delivery
-- stamp and the ON DELETE CASCADE from agent_comm_messages look up message_id.
CREATE INDEX IF NOT EXISTS idx_agent_comm_messages_inbox
  ON agent_comm_messages(recipient_agent_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_wake_events_message
  ON agent_wake_events(message_id);

-- F-274: newest files first without walking every content BLOB.
CREATE INDEX IF NOT EXISTS idx_files_ws_created
  ON files(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_ws_folder_created
  ON files(workspace_id, folder, created_at DESC);

-- F-277: the FK child check on note delete has no deleted_at term, so the
-- partial idx_notes_project cannot serve it.
CREATE INDEX IF NOT EXISTS idx_notes_project_fk ON notes(project_id);


-- F-268: 017 backfilled updated_at_ms with truncated floating-point arithmetic,
-- leaving about half of the legacy rows exactly 1 ms early. Set those to the
-- exact epoch-ms of updated_at (the 025 integer method). No trigger fires on
-- updated_at_ms alone.
UPDATE notes
   SET updated_at_ms = updated_at_ms + 1
 WHERE strftime('%s', updated_at) IS NOT NULL
   AND updated_at_ms = CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                       + COALESCE(CAST(substr(strftime('%f', updated_at), 4, 3) AS INTEGER), 0) - 1;
