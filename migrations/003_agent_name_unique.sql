-- Prevent concurrent creation of duplicate active agent names within a workspace.
-- Partial unique index: only active agents (active = 1) are constrained.
-- Deactivated agents (active = 0) may share a name if reactivation is needed later.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_workspace_name_active
  ON agents(workspace_id, name) WHERE active = 1;
