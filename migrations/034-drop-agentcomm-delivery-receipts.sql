-- AgentComm becomes a plain messenger: delivery is a transport fact, not a
-- receipt somebody has to close by hand.
--
-- The receipt state machine (pending/leased/delivered/failed/dead_letter) put
-- the burden of closing a delivery on the recipient, via voluntary MCP calls
-- inside an LLM turn. A recipient that simply never calls agent_delivery_lease
-- strands its own queue forever, and nobody else is allowed to close it — the
-- lease is recipient-bound by construction. Leo accumulated 13 such receipts,
-- the oldest stuck since 2026-08-02, while the wake transport underneath was
-- healthy the whole time.
--
-- Delivery is now recorded on agent_wake_events.delivered_at, stamped by the
-- server only after the recipient runtime confirms it accepted the messages
-- into a turn. Nothing is left for an agent to close.
--
-- agent_comm_messages and agent_comm_sessions are deliberately untouched here:
-- they hold every message body and the whole conversation history, and the
-- dashboard reads them. Only the index that migration 032 added purely to back
-- the receipt foreign key is left in place as well, since dropping it would
-- change a protected table's schema for no gain.

DROP INDEX IF EXISTS idx_agent_comm_delivery_receipts_due;
DROP INDEX IF EXISTS idx_agent_comm_delivery_receipts_message;
DROP TABLE IF EXISTS agent_comm_delivery_receipts;

-- ack_required marked a message as owing a manual agent_ack. agent_ack is gone,
-- so any row left at 1 could never be closed and would sit in the "unacked"
-- backlog forever. Clear the flag; acked_at / ack_status keep whatever history
-- they already recorded, so nothing is rewritten or lost.
UPDATE agent_comm_messages SET ack_required = 0 WHERE ack_required = 1;

INSERT INTO schema_versions (version, description)
  VALUES (34, '034-drop-agentcomm-delivery-receipts.sql');
