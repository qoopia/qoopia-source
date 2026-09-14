-- Name the column for what it now means.
--
-- Migration 034 removed the receipt ledger, but agent_comm_messages still
-- carried the vocabulary of it: acked_at, ack_status, ack_required. Those
-- columns had already stopped meaning what they say — nothing acknowledges
-- anything any more, and the server records delivery on its own from the
-- recipient runtime's confirmation.
--
-- Leaving a column called acked_at holding "delivered automatically" is the
-- trap: in a month someone reads the name, not the value, and reasons about a
-- handshake that no longer exists. So the column is renamed rather than
-- reused, and the two that have no meaning left at all are dropped.
--
-- SQLite rewrites the column reference inside dependent indexes on RENAME, but
-- the index name itself is part of the same vocabulary, so it is recreated
-- under a name that matches what it indexes.

DROP INDEX IF EXISTS idx_agent_comm_messages_unacked;

ALTER TABLE agent_comm_messages RENAME COLUMN acked_at TO delivered_at;

-- ack_status recorded what the recipient claimed it was doing ('working',
-- 'auto_acked_by_reply', ...). There is no ack, so there is no status.
ALTER TABLE agent_comm_messages DROP COLUMN ack_status;

-- ack_required marked a message as owing a manual acknowledgement. Migration
-- 034 already forced every row to 0 because agent_ack was gone; the column is
-- now a field that can only ever hold "no".
ALTER TABLE agent_comm_messages DROP COLUMN ack_required;

CREATE INDEX IF NOT EXISTS idx_agent_comm_messages_delivered
  ON agent_comm_messages(workspace_id, recipient_agent_id, delivered_at, created_at DESC);

-- Backfill: every message whose wake the runtime already confirmed is
-- delivered, and that fact is already recorded on the wake event. Carry it
-- onto the message so the dashboard can read delivery without a join.
UPDATE agent_comm_messages
   SET delivered_at = (
         SELECT w.delivered_at FROM agent_wake_events w
          WHERE w.message_id = agent_comm_messages.id
            AND w.delivered_at IS NOT NULL
          ORDER BY w.delivered_at ASC
          LIMIT 1)
 WHERE delivered_at IS NULL
   AND EXISTS (
         SELECT 1 FROM agent_wake_events w
          WHERE w.message_id = agent_comm_messages.id
            AND w.delivered_at IS NOT NULL);

-- The wake SLO probe measured "time until the recipient acknowledged". Under
-- the messenger model the same measurement is "time until delivered" — the
-- runtime's confirmation replaced the recipient's ack as the signal, and the
-- historical values measured the same thing by a worse route.
ALTER TABLE wake_slo_probes RENAME COLUMN ack_latency_ms TO delivery_latency_ms;

INSERT INTO schema_versions (version, description)
  VALUES (35, '035-agentcomm-delivered-at.sql');
