-- Per-agent memory policy. Automatic session capture obeys one server-side setting.
-- compatibility: reader=44 tolerant (new columns unread by an older reader); writer=45 required
--   (an older writer keeps inserting session content without consulting memory_mode, so it must
--   not be started against this schema while any agent is set to manual).
-- recovery: forward-fix preferred — the columns are additive and default to the previous
--   behaviour. To undo, restore the verified pre-upgrade backup; a DROP COLUMN is refused here
--   because it would silently re-enable automatic capture for agents switched to manual.
-- data-after-upgrade: session content recorded after the upgrade stays owned by its session and
--   survives a restore only up to the backup point. Policy rows themselves are reconstructible
--   from agent_memory_policy_log, which never stores conversation content. A restored
--   memory_save_decisions row records only who decided and which note resulted, never any text.

-- Existing agents adopt auto, which is what they already did before this migration.
-- An explicit manual set by the owner is recorded on the column and in the log below.
ALTER TABLE agents ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK(memory_mode IN ('auto','manual'));
-- Bumped on every accepted change. An in-flight summary compares it before it commits,
-- so a switch to manual invalidates work that started while auto was still effective.
ALTER TABLE agents ADD COLUMN memory_mode_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN memory_mode_updated_at_ms INTEGER;
ALTER TABLE agents ADD COLUMN memory_mode_actor_id TEXT;

-- Who changed the policy and when. Never the conversation itself.
CREATE TABLE agent_memory_policy_log (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('auto','manual')),
  revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(agent_id,workspace_id) REFERENCES agents(id,workspace_id)
);
CREATE INDEX agent_memory_policy_log_agent ON agent_memory_policy_log(workspace_id,agent_id,id);

-- The owner's decision about a save a manual agent asked for. The prepared text is never stored:
-- it waits in the server's memory and reaches the database only as the note the owner confirmed.
CREATE TABLE memory_save_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('note_create','note_update')),
  request_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('saved','declined')),
  note_id TEXT,
  decided_by TEXT NOT NULL,
  decided_at_ms INTEGER NOT NULL,
  CHECK((decision='saved') = (note_id IS NOT NULL)),
  FOREIGN KEY(agent_id,workspace_id) REFERENCES agents(id,workspace_id)
);
-- Confirming the same material twice returns the note already written instead of writing a second one.
CREATE INDEX memory_save_decisions_material ON memory_save_decisions(workspace_id,agent_id,request_hash,decided_at_ms);
