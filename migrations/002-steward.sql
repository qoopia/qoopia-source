-- Phase 1: Steward agent type support
-- Guarantees at most one active steward per workspace at the DB level.
-- SQLite 3.8+ required for partial unique index (bun:sqlite ships 3.51).

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_steward
  ON agents(workspace_id)
  WHERE type = 'steward' AND active = 1;
