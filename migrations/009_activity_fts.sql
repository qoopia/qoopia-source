-- ============================================================
-- Migration 009: activity_fts virtual table
--
-- Activity log has grown past the "fine for 2k rows" comment in
-- recall.ts; LIKE queries on summary are starting to slow down.
-- Mirror the session_messages_fts pattern: external-content FTS5
-- with content_rowid='id', AI/AD triggers, unicode61 tokenizer
-- consistent with notes_fts and session_messages_fts.
--
-- activity is append-only, so AU trigger is omitted (matches
-- session_messages_fts in 001-initial-schema.sql).
-- ============================================================

CREATE VIRTUAL TABLE activity_fts USING fts5(
  summary,
  content='activity',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER activity_ai AFTER INSERT ON activity BEGIN
  INSERT INTO activity_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;

CREATE TRIGGER activity_ad AFTER DELETE ON activity BEGIN
  INSERT INTO activity_fts(activity_fts, rowid, summary) VALUES('delete', old.rowid, old.summary);
END;

-- Backfill from existing activity rows. Idempotent: drops any prior
-- contents (the table was just created above so this is a no-op on
-- fresh DBs, but defensive on reruns of a partially failed migration).
INSERT INTO activity_fts(activity_fts) VALUES('rebuild');
