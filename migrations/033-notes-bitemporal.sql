-- 033-notes-bitemporal.sql
--
-- V4.1 пункт №2 — би-темпоральные факты. Phase C протокола §5.1.
-- Строго additive: миграции 001–032 неизменны, `notes.metadata` НЕ трогается.
--
-- Порядок Phase A (pure read report) -> Phase B (durable staging) -> Phase C
-- (этот файл). Gate ниже не даёт применить Phase C на базе, где есть
-- supersedes-граф, но нет staging из Phase B: иначе backfill молча пропустил
-- бы классификацию компонент.

-- ---------------------------------------------------------------------------
-- Gate. CHECK-нарушение прерывает миграцию до первой мутации `notes`.
-- Проходит, если Phase B оставила обе staging-таблицы ЛИБО если
-- supersedes-граф пуст (классифицировать и backfill'ить нечего).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS temp.mig033_gate;
CREATE TEMP TABLE mig033_gate (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO mig033_gate (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('mig033_linear_targets', 'mig033_skipped',
                        'mig033_staging_meta')) = 3 THEN 1
  WHEN (SELECT COUNT(*) FROM note_relations
         WHERE relation_type = 'supersedes') = 0 THEN 1
  ELSE 0
END;

-- ---------------------------------------------------------------------------
-- §3.1 additive-колонки `notes`.
-- TEXT ISO — только для отображения; сравнение/сортировка/индексы — *_ms.
-- ---------------------------------------------------------------------------
ALTER TABLE notes ADD COLUMN valid_from        TEXT;
ALTER TABLE notes ADD COLUMN valid_until       TEXT;
ALTER TABLE notes ADD COLUMN invalidated_at    TEXT;
ALTER TABLE notes ADD COLUMN subject_key       TEXT;
ALTER TABLE notes ADD COLUMN supersedes_id     TEXT REFERENCES notes(id);
ALTER TABLE notes ADD COLUMN created_at_ms     INTEGER;
ALTER TABLE notes ADD COLUMN valid_from_ms     INTEGER;
ALTER TABLE notes ADD COLUMN valid_until_ms    INTEGER;
ALTER TABLE notes ADD COLUMN invalidated_at_ms INTEGER;

-- ---------------------------------------------------------------------------
-- §3.5 provenance вне `notes.metadata` (R2), FK на PK `notes(id)` (R5).
-- workspace_id денормализован для запросов; его согласованность гарантируют
-- BEFORE-триггеры, а не составной FK.
-- ---------------------------------------------------------------------------
CREATE TABLE note_temporal_provenance (
  note_id               TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  invalidated_at_source TEXT,
  valid_until_source    TEXT,
  valid_until_inferred  INTEGER NOT NULL DEFAULT 0 CHECK (valid_until_inferred IN (0,1)),
  backfill_class        TEXT,
  skipped_reason        TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE RESTRICT
);

CREATE INDEX idx_ntp_ws ON note_temporal_provenance(workspace_id, backfill_class);

CREATE TRIGGER ntp_ws_consistency_ins
BEFORE INSERT ON note_temporal_provenance
FOR EACH ROW
WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM notes WHERE id = NEW.note_id)
BEGIN SELECT RAISE(ABORT, 'note_temporal_provenance.workspace_id mismatch vs notes'); END;

CREATE TRIGGER ntp_ws_consistency_upd
BEFORE UPDATE OF workspace_id, note_id ON note_temporal_provenance
FOR EACH ROW
WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM notes WHERE id = NEW.note_id)
BEGIN SELECT RAISE(ABORT, 'note_temporal_provenance.workspace_id mismatch vs notes'); END;

-- ---------------------------------------------------------------------------
-- created_at_ms — integer-метод миграции 025. `julianday` запрещён (R3).
-- ---------------------------------------------------------------------------
UPDATE notes SET created_at_ms =
  CAST(strftime('%s', created_at) AS INTEGER) * 1000
  + COALESCE(CAST(substr(strftime('%f', created_at), 4, 3) AS INTEGER), 0)
WHERE created_at_ms IS NULL;

UPDATE notes SET valid_from = created_at, valid_from_ms = created_at_ms
WHERE valid_from IS NULL;

-- ---------------------------------------------------------------------------
-- Staging Phase B. `IF NOT EXISTS` — форма деклараций нужна и в том случае,
-- когда gate прошёл по «пустому supersedes-графу»: SQLite готовит каждый
-- statement по мере исполнения, и обращение к отсутствующей таблице упало бы
-- на prepare. Пустые таблицы делают backfill-запросы ниже no-op.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mig033_linear_targets (
  note_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  invalidated_at_ms INTEGER NOT NULL,
  valid_until_ms    INTEGER NOT NULL,
  invalidated_at_iso TEXT NOT NULL,
  valid_until_iso    TEXT NOT NULL,
  PRIMARY KEY (note_id, workspace_id));

CREATE TABLE IF NOT EXISTS mig033_skipped (
  note_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  backfill_class TEXT NOT NULL, skipped_reason TEXT NOT NULL,
  PRIMARY KEY (note_id, workspace_id));

CREATE TABLE IF NOT EXISTS mig033_staging_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- LINEAR backfill — целые ms и производные ISO предвычислены в TS (R3/R4).
UPDATE notes
SET invalidated_at    = (SELECT invalidated_at_iso FROM mig033_linear_targets t WHERE t.note_id=notes.id AND t.workspace_id=notes.workspace_id),
    invalidated_at_ms = (SELECT invalidated_at_ms  FROM mig033_linear_targets t WHERE t.note_id=notes.id AND t.workspace_id=notes.workspace_id),
    valid_until       = (SELECT valid_until_iso    FROM mig033_linear_targets t WHERE t.note_id=notes.id AND t.workspace_id=notes.workspace_id),
    valid_until_ms    = (SELECT valid_until_ms     FROM mig033_linear_targets t WHERE t.note_id=notes.id AND t.workspace_id=notes.workspace_id)
WHERE invalidated_at_ms IS NULL
  AND EXISTS (SELECT 1 FROM mig033_linear_targets t WHERE t.note_id=notes.id AND t.workspace_id=notes.workspace_id);

-- Provenance linear: transaction-time наблюдаемое, valid-time выведенное.
-- OR IGNORE — resume Phase C после сбоя повторяет вставку по PK note_id.
INSERT OR IGNORE INTO note_temporal_provenance
  (note_id, workspace_id, invalidated_at_source, valid_until_source, valid_until_inferred, backfill_class)
SELECT note_id, workspace_id, 'note_relations.created_at', 'inferred_from_relation', 1, 'linear'
  FROM mig033_linear_targets;

-- Provenance/tags для SKIPPED (split_head|cyclic|oversize): conservative,
-- `notes` не мутируется, winner молча не выбирается (R1).
INSERT OR IGNORE INTO note_temporal_provenance
  (note_id, workspace_id, backfill_class, skipped_reason)
SELECT note_id, workspace_id, backfill_class, skipped_reason FROM mig033_skipped;

-- ---------------------------------------------------------------------------
-- Индексы. Диапазоны и сортировки — только по *_ms.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_notes_current_ws       ON notes(workspace_id, created_at_ms DESC) WHERE invalidated_at_ms IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_notes_current_ws_type  ON notes(workspace_id, type, created_at_ms DESC) WHERE invalidated_at_ms IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_notes_valid_ms         ON notes(workspace_id, valid_from_ms, valid_until_ms);
CREATE INDEX idx_notes_known_ms         ON notes(workspace_id, created_at_ms, invalidated_at_ms);
CREATE INDEX idx_notes_subject_valid    ON notes(workspace_id, subject_key, valid_from_ms) WHERE subject_key IS NOT NULL;
CREATE INDEX idx_notes_supersedes_id    ON notes(supersedes_id) WHERE supersedes_id IS NOT NULL;

DROP TABLE mig033_linear_targets;
DROP TABLE mig033_skipped;
DROP TABLE mig033_staging_meta;
DROP TABLE IF EXISTS temp.mig033_gate;

INSERT INTO schema_versions (version, description) VALUES (33, '033-notes-bitemporal.sql');
