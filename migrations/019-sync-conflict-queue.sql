-- 019-sync-conflict-queue.sql — table for unresolvable shadow-sync conflicts.
-- Phase 2 Item B (plan note 01KSC0E9F1WFWJMSP58KS34H2A) step 1, Q-P2-2 Q3 decision:
-- CLI-only review UX (Leo R1 OK).
--
-- Written ONLY by the --apply path of /srv/qoopia/code/src/services/shadow_sync.ts.
-- Dry-run never writes here — it surfaces conflict counts in the report footer
-- only (per the dry-run discipline rule from Leo R1 BLOCK → R2 fix on Item B).
--
-- Rollback: /srv/qoopia/code/migrations/rollback/019-sync-conflict-queue.rollback.sql.

CREATE TABLE IF NOT EXISTS sync_conflict_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  table_name      TEXT    NOT NULL,
  row_id          TEXT    NOT NULL,
  direction       TEXT    NOT NULL CHECK (direction IN ('M2C','C2M')),
  local_updated_at_ms  INTEGER NOT NULL,
  remote_updated_at_ms INTEGER NOT NULL,
  local_hash      TEXT    NOT NULL,
  remote_hash     TEXT    NOT NULL,
  field_diff_summary TEXT NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN
                    ('pending','resolved_local','resolved_remote',
                     'resolved_manual','dismissed')) DEFAULT 'pending',
  resolved_at     TEXT,
  resolved_by     TEXT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_conflict_queue_status_created
  ON sync_conflict_queue(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_conflict_queue_row
  ON sync_conflict_queue(table_name, row_id);

INSERT INTO schema_versions (version, description)
  VALUES (19, '019-sync-conflict-queue.sql');
