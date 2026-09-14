-- migrations/010_agent_tool_profile.sql
-- QSA-F / Codex QSA-004 / ADR-016: per-agent tool risk profile.
--
-- Adds a `tool_profile` enum column to agents so an operator can demote
-- a single agent to a safer subset of MCP tools without changing the
-- agent's `type` (which is also load-bearing for visibility, OAuth flows,
-- and the steward unique constraint).
--
-- Profiles:
--   read-only       — only risk='read' tools registered
--   no-destructive  — read + write-low (no note_delete, no agent_*)
--   full            — current behavior (every tool the agent's type
--                     qualifies for is registered)
--
-- The DEFAULT 'full' preserves behavior for every existing agent — no
-- forced lockout at deploy time. Operators downgrade specific agents
-- via the steward-only `agent_set_profile` MCP tool (ADR-016).
--
-- IMPORTANT scope limitation: this column constrains the MCP boundary
-- only. The dashboard `/api/dashboard/*` endpoints have their own
-- admin-type gate (ADMIN_TYPES) and are NOT filtered by tool_profile.
-- See ADR-016 "Out of scope: dashboard endpoints".
--
-- Created: 2026-04-28

ALTER TABLE agents
  ADD COLUMN tool_profile TEXT NOT NULL DEFAULT 'full'
  CHECK (tool_profile IN ('read-only', 'no-destructive', 'full'));
