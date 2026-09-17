-- Telegram receipt is durable before its update is acknowledged. Bot tokens stay in private files.
CREATE TABLE qoopia_telegram_channels (
  owner_id TEXT PRIMARY KEY REFERENCES qoopia_agent_settings(owner_id),
  generation TEXT NOT NULL,
  bot_id TEXT,
  pairing_code TEXT,
  pairing_expires INTEGER,
  candidate_id TEXT,
  candidate_chat TEXT,
  candidate_name TEXT,
  conversation_id TEXT REFERENCES qoopia_agent_conversations(id),
  paused INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  last_poll_at INTEGER,
  retry_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
INSERT INTO qoopia_telegram_channels(owner_id,generation,conversation_id)
SELECT owner_id,lower(hex(randomblob(16))),active_conversation_id FROM qoopia_agent_settings
WHERE telegram_username IS NOT NULL;
CREATE TABLE qoopia_telegram_inbox (
  owner_id TEXT NOT NULL REFERENCES qoopia_agent_settings(owner_id),
  generation TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'codex' CHECK(provider IN ('codex','claude_code')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','starting','running','done','failed','cancelled')),
  run_id TEXT REFERENCES qoopia_agent_runs(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,generation,update_id)
);
CREATE INDEX qoopia_telegram_inbox_pending ON qoopia_telegram_inbox(owner_id,generation,state,update_id);
CREATE TABLE qoopia_telegram_outbox (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES qoopia_agent_settings(owner_id),
  generation TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  body TEXT NOT NULL,
  run_id TEXT REFERENCES qoopia_agent_runs(id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','sent','uncertain','cancelled')),
  message_id INTEGER,
  retry_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_id,generation,delivery_key)
);
ALTER TABLE qoopia_agent_telegram_delivery ADD COLUMN generation TEXT;

UPDATE qoopia_agent_telegram_delivery SET generation=(
 SELECT ch.generation FROM qoopia_agent_runs r JOIN qoopia_agent_conversations c ON c.id=r.conversation_id
 JOIN qoopia_telegram_channels ch ON ch.owner_id=c.owner_id WHERE r.id=qoopia_agent_telegram_delivery.run_id
);
