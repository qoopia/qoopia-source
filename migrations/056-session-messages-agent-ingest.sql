-- compatibility: schema-55 readers keep working; the index only speeds a lookup they do not make.
-- recovery: drop the index (migrations/rollback/056-*.rollback.sql) or restore the pre-migration backup before returning to schema-55 software.
-- data-after-upgrade: no row changes.
-- A record of one native transcript is stored once per agent, whichever session id carries it: a
-- resumed, forked or restarted Claude Code session writes a new transcript that starts with a copy of
-- the earlier one under the same record ids. Ingest looks those ids up across the agent's sessions [5.0.24].
CREATE INDEX idx_session_messages_agent_ingest ON session_messages(workspace_id, agent_id, ingest_uuid)
  WHERE ingest_uuid IS NOT NULL;
