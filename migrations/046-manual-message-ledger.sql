-- The exact boundary of a manual period, without trusting the client's clock.
-- compatibility: reader=45 tolerant (an older reader ignores this table); writer=45 tolerant
--   (an older writer simply does not record ids, which costs precision, never correctness: the
--   timestamp guard it already applies still refuses the manual period).
-- recovery: forward-fix. Dropping the table only returns the previous, coarser behaviour.
-- data-after-upgrade: identifiers only. A client supplies these ids with every batch; the row
--   records that an id was refused while the agent was manual, never the message itself, its
--   text, its role or any digest of it. Nothing here can reconstruct a conversation.

-- A batch that resumes a session across a manual period carries both halves: turns from the
-- period, which must never be kept, and turns from after it, which the owner expects to keep.
-- Dropping the whole batch loses the second half. The client already showed the first half to
-- this server while the agent was manual, so remembering those ids separates the two exactly.
CREATE TABLE manual_period_messages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seen_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, session_id, message_id),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id)
) WITHOUT ROWID;

-- Maintenance prunes by age; the lookup is by the batch's own session.
CREATE INDEX manual_period_messages_age ON manual_period_messages(seen_at_ms);
