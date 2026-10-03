import { db } from "../../src/db/connection.ts";
import { createAgent } from "../../src/admin/agents.ts";

/** ADR-020: a pre-existing 'claude-privileged' row. New agents can no longer be created with that type. */
export function legacyPrivilegedAgent(name: string, workspaceSlug: string) {
  const agent = createAgent({ name, workspaceSlug });
  db.query("UPDATE agents SET type = 'claude-privileged' WHERE id = ?").run(agent.id);
  return agent;
}
