-- 017-updated-at-ms.sql — ms-precision updated_at column on notes.
-- Phase 2 Item B (plan note 01KSC0E9F1WFWJMSP58KS34H2A), Q-P2-3 / Q5 decision:
-- schema upgrade preferred over dual-mode runtime detection (Leo R1 OK).
--
-- Adds `updated_at_ms INTEGER NOT NULL DEFAULT 0`. Existing rows are backfilled
-- once from `updated_at` via the julianday formula (1 Julian day = 86_400_000 ms;
-- 2440587.5 is the Julian day for 1970-01-01T00:00:00Z, the Unix epoch). New
-- writes are expected to set updated_at_ms alongside updated_at (sync engine
-- treats ms=0 as "legacy row, fall back to text comparison").
--
-- Rollback: /srv/qoopia/code/migrations/rollback/017-updated-at-ms.rollback.sql.

ALTER TABLE notes ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

UPDATE notes
   SET updated_at_ms = CAST((julianday(updated_at) - 2440587.5) * 86400000 AS INTEGER)
 WHERE updated_at_ms = 0;

CREATE INDEX IF NOT EXISTS idx_notes_updated_at_ms
  ON notes(updated_at_ms);

INSERT INTO schema_versions (version, description)
  VALUES (17, '017-updated-at-ms.sql');
