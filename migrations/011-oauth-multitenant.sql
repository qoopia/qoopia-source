-- migrations/011-oauth-multitenant.sql
-- ADR-017: multi-tenant OAuth via dashboard cookie session.
--
-- (a) Denormalize workspace_id onto oauth_clients so the consent-ticket
--     workspace match can be done without joining agents on every authorize
--     redirect. NULL is allowed for one release so existing rows are
--     backfillable; migration 014 will tighten this to NOT NULL once the
--     write path is known to populate it and production has had a clean
--     30-day observation window with no NULL workspace_id writes.
-- (b) Introduce a server-side consent_tickets table. Each row is one
--     in-flight /oauth/authorize attempt waiting for a dashboard-side
--     operator to approve or deny. The /oauth/* surface itself never reads
--     the dashboard cookie (ADR-015 §"the cookie is never attached outside
--     dashboard routes" is preserved); approval is brokered by the dashboard
--     surface and trusted via this ticket row.
--
-- Created: 2026-04-28

ALTER TABLE oauth_clients ADD COLUMN workspace_id TEXT;

-- Backfill workspace_id from the agent's workspace. Future inserts populate
-- the column directly via registerClient(); migration 014 will add a
-- NOT NULL constraint via table rewrite after the observation window.
UPDATE oauth_clients
SET workspace_id = (
  SELECT workspace_id FROM agents WHERE agents.id = oauth_clients.agent_id
)
WHERE workspace_id IS NULL;

CREATE TABLE consent_tickets (
  id                    TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  workspace_id          TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT NOT NULL DEFAULT '',
  state                 TEXT NOT NULL DEFAULT '',
  approved_by_agent_id  TEXT,
  denied                INTEGER NOT NULL DEFAULT 0,
  redeemed              INTEGER NOT NULL DEFAULT 0,
  approve_nonce         TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE
);

CREATE INDEX consent_tickets_expires ON consent_tickets(expires_at);
CREATE INDEX consent_tickets_client ON consent_tickets(client_id);
