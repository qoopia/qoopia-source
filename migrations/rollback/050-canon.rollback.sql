-- Rollback for 050-canon.sql: drops the canon tables. The rule notes canons were imported from stay in notes.
DROP TABLE IF EXISTS canon_applications;
DROP TABLE IF EXISTS canon_embeddings;
DROP TRIGGER IF EXISTS canons_au;
DROP TRIGGER IF EXISTS canons_ad;
DROP TRIGGER IF EXISTS canons_ai;
DROP TABLE IF EXISTS canons_fts;
DROP TABLE IF EXISTS canons;

DELETE FROM schema_versions WHERE version = 50;
