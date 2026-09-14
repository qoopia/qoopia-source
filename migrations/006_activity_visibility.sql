-- migrations/006_activity_visibility.sql
-- QTHIRD-001: stamp activity rows with the visibility of the note they
-- describe, so that listActivity / recall(scope='activity'|'all') can
-- hide rows that reveal the existence (and original 80-char preview) of
-- another agent's private note.
-- Created: 2026-04-26
--
-- Default 'workspace' preserves current behavior for all historical rows
-- and for any activity that is not tied to a private-visibility note.
-- Notes-related activity created from now on inherits the note's
-- visibility at write time (see src/services/notes.ts).

ALTER TABLE activity ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'
  CHECK (visibility IN ('workspace', 'private'));

-- Composite index used by the read-path filter
--   (workspace_id = ? AND (visibility = 'workspace' OR agent_id = ? OR ?))
-- to keep the per-agent activity scan cheap.
CREATE INDEX idx_activity_visibility_owner
  ON activity(workspace_id, visibility, agent_id);
