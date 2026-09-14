-- 022-entity-links.sql — directed link graph between entity pages.
-- Phase 2 Item C step 2 (plan note 01KSC0E9F1WFWJMSP58KS34H2A).
-- Preflight: 01KSCWHV14J0YHJV310YDXRGFP.
--
-- Soft FKs: source_entity_id and target_entity_id are NOT declared with
-- a SQLite FOREIGN KEY because the orphan-link sweeper ships separately
-- (Item E, nightly cron). Hard FKs would refuse to archive an entity
-- that still has incoming links — the operator-friendly path is to
-- archive freely and let the sweeper surface dangling links the next
-- morning. The service layer DOES validate both ends exist on insert
-- (see src/services/entities.ts addLink()), so callers can never write
-- a brand-new orphan.
--
-- relation_type is a free-form TEXT column — vocabulary lives in
-- src/services/entities.ts so adding a new relation type does not
-- require a migration. Reserved vocabulary at ship time:
-- 'participants', 'depends_on', 'supersedes', 'related_to',
-- 'documents', 'triggers'.
--
-- Self-loops are forbidden at the DB level via CHECK — Phase 2 Item C
-- self-review checklist §"Link CHECK constraint prevents source=target
-- self-loops".
--
-- Idempotency: UNIQUE(source, target, relation_type) — callers use
-- INSERT OR IGNORE so duplicate links are no-ops (matches plan §3
-- "duplicate (from,to,kind) triple is a no-op").
--
-- Rollback: /srv/qoopia/code/migrations/rollback/022-entity-links.rollback.sql.

CREATE TABLE IF NOT EXISTS entity_links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entity_id  TEXT NOT NULL,
  target_entity_id  TEXT NOT NULL,
  relation_type     TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 1.0,
  source            TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (source_entity_id <> target_entity_id),
  UNIQUE (source_entity_id, target_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_links_source
  ON entity_links(source_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_links_target
  ON entity_links(target_entity_id);

INSERT INTO schema_versions (version, description)
  VALUES (22, '022-entity-links.sql');
