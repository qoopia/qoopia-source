-- Conversation state belongs to the owner's installation and its normal backups.
-- Native credentials and Telegram bot tokens are deliberately kept out of this DB.
CREATE TABLE qoopia_agent_settings (
  owner_id TEXT PRIMARY KEY REFERENCES agents(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  active_conversation_id TEXT REFERENCES qoopia_agent_conversations(id),
  channel TEXT NOT NULL DEFAULT 'dashboard' CHECK(channel IN ('dashboard','telegram')),
  telegram_username TEXT,
  telegram_user_id TEXT,
  telegram_chat_id TEXT,
  telegram_offset INTEGER NOT NULL DEFAULT 0,
  telegram_verified INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE qoopia_agent_conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES qoopia_agent_settings(owner_id),
  title TEXT NOT NULL,
  native_thread_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE qoopia_agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES qoopia_agent_conversations(id),
  request_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('starting','running','approval','completed','interrupted','failed')),
  native_turn_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id, request_id)
);
CREATE INDEX qoopia_agent_runs_conversation ON qoopia_agent_runs(conversation_id, created_at);
CREATE TABLE qoopia_agent_telegram_delivery (
  run_id TEXT PRIMARY KEY REFERENCES qoopia_agent_runs(id),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','uncertain')),
  message_id INTEGER
);

CREATE UNIQUE INDEX qoopia_agent_telegram_bot ON qoopia_agent_settings(telegram_username COLLATE NOCASE) WHERE telegram_username IS NOT NULL;
