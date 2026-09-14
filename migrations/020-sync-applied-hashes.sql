-- 020-sync-applied-hashes.sql — idempotency hash store for shadow-sync --apply.
-- Phase 2 Item B (plan note 01KSC0E9F1WFWJMSP58KS34H2A) step 1.
--
-- Schema rationale (Leo R2 revision):
--   PK = hash (sha256 hex, 64 chars). O(1) dedup on hash lookup. Secondary
--   index on (table_name, row_id) for the post-apply audit query "what hashes
--   have I applied for note <id>?".
--
-- Hash formula (computed by sync_engine, NOT by the DB):
--   H = sha256(table_name || 0x0A || row_id || 0x0A || updated_at_ms ||
--              0x0A || canonical_field_set)
-- where canonical_field_set serializes the synced fields with sorted JSON
-- keys (RFC 8785 JCS-style) and 0x0A as field separator.
--
-- Written ONLY by the --apply path of shadow_sync.ts, AFTER the row mutation
-- succeeds. Dry-run NEVER touches this table (per Leo R1 BLOCK → R2 fix).
--
-- Rollback: /srv/qoopia/code/migrations/rollback/020-sync-applied-hashes.rollback.sql.

CREATE TABLE IF NOT EXISTS sync_applied_hashes (
  hash          TEXT PRIMARY KEY,
  table_name    TEXT NOT NULL,
  row_id        TEXT NOT NULL,
  applied_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  direction     TEXT NOT NULL CHECK (direction IN ('M2C','C2M'))
);

CREATE INDEX IF NOT EXISTS idx_sync_applied_hashes_table_row
  ON sync_applied_hashes(table_name, row_id);

INSERT INTO schema_versions (version, description)
  VALUES (20, '020-sync-applied-hashes.sql');
