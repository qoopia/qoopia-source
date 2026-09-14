-- Rollback for 023-skill-metadata-schema.sql.
-- Documentation-only forward migration — only the schema_versions row
-- needs to be removed. entity_pages rows of type='skill' are left in
-- place; if a caller wants to purge them, that is an explicit data
-- operation, not a schema rollback.

DELETE FROM schema_versions WHERE version = 23;
