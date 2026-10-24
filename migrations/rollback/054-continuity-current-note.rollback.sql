DROP INDEX notes_continuity_session;
CREATE UNIQUE INDEX notes_continuity_session ON notes(workspace_id,agent_id,session_id)
  WHERE source='qoopia-continuity' AND deleted_at IS NULL;
