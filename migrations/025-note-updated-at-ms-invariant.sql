-- 025-note-updated-at-ms-invariant.sql
--
-- WS-3: database backstop for note writers outside services/notes.ts.
-- Normal create/update/delete paths allocate a strictly increasing timestamp
-- atomically in their write transaction. These triggers ensure a direct INSERT
-- cannot create another updated_at_ms=0 row and repair a legacy zero row if a
-- direct business-field UPDATE touches it.
--
-- Deliberately NO historical backfill occurs here. Existing zero rows require
-- a separately approved backup + operator run; see
-- docs/operations/note-updated-at-ms-backfill.md.

CREATE TRIGGER IF NOT EXISTS notes_updated_at_ms_after_insert
AFTER INSERT ON notes
WHEN NEW.updated_at_ms <= 0
BEGIN
  UPDATE notes
     SET updated_at_ms = CASE
       WHEN strftime('%s', NEW.updated_at) IS NOT NULL THEN
         CAST(strftime('%s', NEW.updated_at) AS INTEGER) * 1000
         + COALESCE(CAST(substr(strftime('%f', NEW.updated_at), 4, 3) AS INTEGER), 0)
       ELSE
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
         + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
     END
   WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS notes_updated_at_ms_after_legacy_update
AFTER UPDATE OF workspace_id, agent_id, type, text, metadata, project_id,
                task_bound_id, session_id, source, tags, visibility, deleted_at
ON notes
WHEN NEW.updated_at_ms <= 0
BEGIN
  UPDATE notes
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at_ms =
           CAST(strftime('%s', 'now') AS INTEGER) * 1000
           + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
   WHERE rowid = NEW.rowid;
END;

INSERT INTO schema_versions (version, description)
  VALUES (25, '025-note-updated-at-ms-invariant.sql');
