-- recall_log — per-call recall telemetry for post-hoc regression analysis
-- and SLO measurement of the hybrid/deep rerank stages.
-- Phase 1 plan note 01KSBK5KDR6532W95YV11M4VVS (item 6). Preflight
-- 01KSBQ6Y9QTZRM1M9S70T8MF0F.
--
-- Host-local telemetry: explicitly EXCLUDED from any future shadow sync
-- (item 5). Stores metadata only — query_text is REDACTED at insert by
-- /srv/qoopia/code/src/services/recall_log_redaction.ts BEFORE the
-- INSERT statement. The redactor mirrors the regex set in §5 of
-- /srv/qoopia/docs/secret-safe-audit-rubric.md (Phase 1 item 7).
--
-- NO secondary index on query_text. FTS on the query corpus is out of
-- scope, and a secondary index would be a recovery surface for any
-- token that slipped past redaction.

CREATE TABLE IF NOT EXISTS recall_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  caller_agent  TEXT    NOT NULL,
  workspace_id  TEXT    NOT NULL,
  query_text    TEXT    NOT NULL,
  top_k         INTEGER NOT NULL,
  result_ids    TEXT    NOT NULL,
  result_scores TEXT    NOT NULL,
  latency_ms    INTEGER NOT NULL,
  backend_path  TEXT    NOT NULL CHECK (backend_path IN ('fts','vector','hybrid','deep','deep_llm')),
  scope         TEXT,
  deep_used     INTEGER NOT NULL DEFAULT 0 CHECK (deep_used IN (0,1)),
  error_class   TEXT
);

-- Primary read pattern: rolling window scans for SLO + the 90d retention
-- sweep in /srv/qoopia/scripts/recall_log_retention.sh.
CREATE INDEX IF NOT EXISTS idx_recall_log_created_at
  ON recall_log(created_at);

-- Per-agent debugging read pattern. DESC matches the "latest first"
-- enumeration the operator typically wants.
CREATE INDEX IF NOT EXISTS idx_recall_log_caller_agent_created
  ON recall_log(caller_agent, created_at DESC);

INSERT INTO schema_versions (version, description)
  VALUES (15, 'recall_log — Phase 1 item 6');
