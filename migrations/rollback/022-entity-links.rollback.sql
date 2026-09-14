-- Rollback for 022-entity-links.sql.
-- Additive migration — drops indices, table, and the schema_versions row.

DROP INDEX IF EXISTS idx_entity_links_target;
DROP INDEX IF EXISTS idx_entity_links_source;
DROP TABLE IF EXISTS entity_links;

DELETE FROM schema_versions WHERE version = 22;
