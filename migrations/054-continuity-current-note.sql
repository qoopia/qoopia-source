-- compatibility: schema-53 readers keep working; they may read a superseded working-state note of a session.
-- recovery: restore the pre-migration backup before returning to schema-53 software.
-- data-after-upgrade: no row changes; a session may now keep superseded working-state notes beside its current one.
-- One working-state note in force per agent/session. A superseded note stays as history (invalidated_at_ms
-- set), so the uniqueness counts only the note still in force: the cleaned copy of a note the memory
-- processor had filled with its own rules supersedes it instead of deleting it [hotfix 5.0.24].
DROP INDEX notes_continuity_session;
CREATE UNIQUE INDEX notes_continuity_session ON notes(workspace_id,agent_id,session_id)
  WHERE source='qoopia-continuity' AND deleted_at IS NULL AND invalidated_at_ms IS NULL;
