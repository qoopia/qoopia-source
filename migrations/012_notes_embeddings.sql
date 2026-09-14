-- ============================================================
-- Migration 012: notes_embeddings — dense vector store for hybrid recall
--
-- FTS5 (notes_fts) has no morphology and no synonyms (tokenizer
-- `unicode61 remove_diacritics 2`). The 20-query baseline measurement
-- (docs/recall-baseline.txt) shows 4/9 mono-term queries returning 0
-- hits even after the OR-default sanitizer fix:
--   - "крашнулся"  → 0 hits (corpus has "сломался", "рухнул", post-mortem)
--   - "починили"   → 0 hits (corpus has "восстановили", "поднял заново")
--   - "сломалась"  → 0 hits (morphology mismatch with "сломал")
--   - "postmortem" → 0 hits (corpus has "post-mortem", hyphen tokenizes)
--
-- This migration backs the hybrid recall path: bge-m3 1024-d float32
-- vectors stored as BLOBs keyed by note_id. RRF (k=60) fusion in
-- src/services/recall.ts unions the FTS5 ranking with the cosine-similarity
-- ranking. Vectors are computed by src/services/embeddings.ts (calls
-- local Ollama at 127.0.0.1:11434, no external API).
--
-- Storage cost: 1024 × 4 bytes = 4 KiB per note. 737 active notes today
-- → ~3 MiB. Cosine is computed in JS on the candidate set per query —
-- cheap at this corpus size (no sqlite-vec extension needed).
--
-- Triggers:
--   - AD on notes: keep store clean on hard delete. (Soft delete leaves
--     the embedding; recall() filters via JOIN on deleted_at IS NULL.)
--   - Upserts are NOT triggered automatically — embedding is async work
--     done by the app layer (Ollama call). Notes can be created without
--     an embedding row; recall() simply won't surface them via the
--     vector channel until backfill runs.
-- ============================================================

CREATE TABLE notes_embeddings (
  note_id      TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- Float32Array packed little-endian. Length must equal dim * 4 bytes.
  embedding    BLOB NOT NULL,
  dim          INTEGER NOT NULL,
  -- Model identifier — lets us detect & rebuild when the embedder changes
  -- (e.g. bge-m3 → multilingual-e5). recall() filters on the active model.
  model        TEXT NOT NULL,
  embedded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- text_hash lets backfill skip notes whose text is unchanged since the
  -- last embed (handles the updateNote path without re-embedding when
  -- only metadata changed). sha256(text) hex.
  text_hash    TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX idx_notes_embeddings_workspace
  ON notes_embeddings(workspace_id);

CREATE INDEX idx_notes_embeddings_model
  ON notes_embeddings(model);

-- Hard-delete cleanup. (FK ON DELETE CASCADE covers the case where the
-- notes row is fully removed; this trigger is the belt to that
-- suspenders.) Soft delete leaves the embedding so re-undeleting is
-- cheap; recall() filters deleted rows via the JOIN.
CREATE TRIGGER notes_embeddings_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_embeddings WHERE note_id = old.id;
END;
