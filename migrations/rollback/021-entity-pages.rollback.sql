-- Rollback for 021-entity-pages.sql.
-- Drops triggers, FTS shadow, indices, and the two base tables.
-- Additive migration — no data loss to non-Item-C tables.
-- entity_embeddings.entity_id ON DELETE CASCADE means the children
-- vanish with the parent if the rollback is run while rows are still
-- present, but the table drop itself handles that whether or not
-- cascades fire.

DROP TRIGGER IF EXISTS entity_pages_au;
DROP TRIGGER IF EXISTS entity_pages_ad;
DROP TRIGGER IF EXISTS entity_pages_ai;

DROP TABLE IF EXISTS entity_pages_fts;

DROP INDEX IF EXISTS idx_entity_embeddings_model;
DROP INDEX IF EXISTS idx_entity_embeddings_workspace;
DROP TABLE IF EXISTS entity_embeddings;

DROP INDEX IF EXISTS idx_entity_pages_slug;
DROP INDEX IF EXISTS idx_entity_pages_type_workspace;
DROP TABLE IF EXISTS entity_pages;

DELETE FROM schema_versions WHERE version = 21;
