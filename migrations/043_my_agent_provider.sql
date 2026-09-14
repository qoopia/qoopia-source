-- Existing conversations belong to Codex; never resume them in another provider.
ALTER TABLE qoopia_agent_settings ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex' CHECK(provider IN ('codex','claude_code'));
ALTER TABLE qoopia_agent_conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex' CHECK(provider IN ('codex','claude_code'));
