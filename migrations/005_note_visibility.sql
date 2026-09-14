-- migrations/005_note_visibility.sql
-- Phase 7b: per-note visibility flag (QRERUN-003)
-- Created: 2026-04-25
--
-- Default behavior remains unchanged: all notes are workspace-visible, so
-- agents within one workspace continue to share memory through MCP recall,
-- brief, note_get, and note_list. The new 'private' value lets an agent
-- mark a note as visible only to itself (and to admin agent types).
--
-- See docs/decisions/ADR-013-mcp-memory-boundary.md for the rationale.

ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'
  CHECK (visibility IN ('workspace', 'private'));

-- Speeds up the per-agent filter on read paths when private notes exist.
CREATE INDEX idx_notes_visibility_owner
  ON notes(workspace_id, visibility, agent_id);
