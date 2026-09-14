-- migrations/007_scrub_legacy_private_activity.sql
-- QFOURTH-001: Codex 4th review found that migration 006 added
-- activity.visibility with DEFAULT 'workspace', which means every
-- historical row that was logged BEFORE QTHIRD-001 (when createNote
-- still embedded the first 80 chars of a private note's text into the
-- shared activity log) is now flagged 'workspace' and stays visible to
-- siblings under the new listActivity / recall(scope='activity'|'all')
-- filter.
--
-- This migration backfills those leaked rows in two ways:
--   1. Stamp visibility='private' so the runtime filter hides them from
--      non-owner non-admin callers.
--   2. Scrub the summary text to drop the original 80-char preview, so
--      even if a future code path bypasses the filter, the secret is
--      no longer recoverable from the row itself.
--
-- The match condition uses the current visibility of the referenced
-- note: the only reason an activity row needs scrubbing is because the
-- note it describes is currently 'private'. Notes whose visibility is
-- 'workspace' had no secret to leak in the first place.
--
-- Idempotent: running twice is a no-op (rows are already 'private' and
-- already scrubbed).
-- Created: 2026-04-26

UPDATE activity
   SET visibility = 'private',
       summary = 'Created note (private) [scrubbed by migration 007]'
 WHERE entity_type = 'note'
   AND action = 'created'
   AND visibility = 'workspace'
   AND entity_id IN (SELECT id FROM notes WHERE visibility = 'private');

-- Also scrub any 'updated' / 'deleted' activity rows that referenced a
-- now-private note with a visibility='workspace' stamp from the legacy
-- code path. Same rationale, different action verbs.
UPDATE activity
   SET visibility = 'private',
       summary = 'Updated note (private) [scrubbed by migration 007]'
 WHERE entity_type = 'note'
   AND action = 'updated'
   AND visibility = 'workspace'
   AND entity_id IN (SELECT id FROM notes WHERE visibility = 'private');

UPDATE activity
   SET visibility = 'private',
       summary = 'Deleted note (private) [scrubbed by migration 007]'
 WHERE entity_type = 'note'
   AND action = 'deleted'
   AND visibility = 'workspace'
   AND entity_id IN (SELECT id FROM notes WHERE visibility = 'private');
