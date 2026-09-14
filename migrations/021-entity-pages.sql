-- 021-entity-pages.sql — durable canonical entity layer (Phase 2 Item C).
-- Plan note: 01KSC0E9F1WFWJMSP58KS34H2A §"Item C — Entity pages MVP".
-- Preflight: 01KSCWHV14J0YHJV310YDXRGFP.
--
-- An entity page is the SoT for facts about persons, agents, machines,
-- services, projects, protocols, incidents, skills, and free-form
-- knowledge topics. Notes link entities by id; recall surfaces entity
-- pages alongside notes via FTS5 + bge-m3.
--
-- Workspace boundary: `workspace_id` is NEVER NULL. Slug uniqueness is
-- scoped to the workspace (a fresh tenant can use the same slug as an
-- existing one). FTS5 mirror `entity_pages_fts` is workspace-agnostic
-- (matches notes_fts behaviour); the service layer filters on
-- `workspace_id` after the MATCH join.
--
-- Embeddings live in a sibling `entity_embeddings` table — same shape
-- as `notes_embeddings` (migration 012), separated so the FK target is
-- `entity_pages(id)` instead of `notes(id)`. Recall fuses both channels
-- in the existing RRF pipeline (src/services/recall.ts).
--
-- Type allowlist intentionally includes `machine` and `knowledge` on
-- top of the Phase 2 plan list — Tailscale hosts and free-form SoT
-- pages have no other natural home. Adding a new type later requires
-- a follow-up migration (or a CHECK relaxation) — the small cost buys
-- the durability guarantee that the catalogue is the only place where
-- the vocabulary changes.
--
-- Rollback: /srv/qoopia/code/migrations/rollback/021-entity-pages.rollback.sql.

CREATE TABLE IF NOT EXISTS entity_pages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  type          TEXT NOT NULL CHECK (type IN (
    'person', 'agent', 'machine', 'service', 'project',
    'protocol', 'incident', 'skill', 'knowledge'
  )),
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'archived', 'deprecated'
  )),
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_entity_pages_type_workspace
  ON entity_pages(type, workspace_id);

CREATE INDEX IF NOT EXISTS idx_entity_pages_slug
  ON entity_pages(workspace_id, slug);

-- FTS5 mirror (mirrors notes_fts pattern from migration 001).
-- Indexed columns: title (highest signal for entity lookup), summary,
-- and slug (so `recall("corsair-main-agent")` hits even when the slug
-- isn't repeated in the title or summary). `unicode61 remove_diacritics 2`
-- matches notes_fts so the sanitizer in recall.ts is reusable.
CREATE VIRTUAL TABLE IF NOT EXISTS entity_pages_fts USING fts5(
  title,
  summary,
  slug,
  content='entity_pages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Triggers: keep the FTS shadow in sync with the base table.
CREATE TRIGGER IF NOT EXISTS entity_pages_ai AFTER INSERT ON entity_pages BEGIN
  INSERT INTO entity_pages_fts(rowid, title, summary, slug)
    VALUES (new.rowid, new.title, COALESCE(new.summary, ''), new.slug);
END;

CREATE TRIGGER IF NOT EXISTS entity_pages_ad AFTER DELETE ON entity_pages BEGIN
  INSERT INTO entity_pages_fts(entity_pages_fts, rowid, title, summary, slug)
    VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''), old.slug);
END;

CREATE TRIGGER IF NOT EXISTS entity_pages_au AFTER UPDATE
  OF title, summary, slug ON entity_pages BEGIN
  INSERT INTO entity_pages_fts(entity_pages_fts, rowid, title, summary, slug)
    VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''), old.slug);
  INSERT INTO entity_pages_fts(rowid, title, summary, slug)
    VALUES (new.rowid, new.title, COALESCE(new.summary, ''), new.slug);
END;

-- Dense vector store for hybrid recall (mirrors notes_embeddings from
-- migration 012). Separate table — FK target is entity_pages(id), not
-- notes(id). Same float32-LE-BLOB serialization, same dim/model fields,
-- same text_hash idempotency key so re-upserts of unchanged content
-- skip the embedder.
CREATE TABLE IF NOT EXISTS entity_embeddings (
  entity_id     TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  dim           INTEGER NOT NULL,
  model         TEXT NOT NULL,
  embedded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  text_hash     TEXT NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entity_pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entity_embeddings_workspace
  ON entity_embeddings(workspace_id);

CREATE INDEX IF NOT EXISTS idx_entity_embeddings_model
  ON entity_embeddings(model);

INSERT INTO schema_versions (version, description)
  VALUES (21, '021-entity-pages.sql');
