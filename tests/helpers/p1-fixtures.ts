import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { splitSqlStatements } from "../../src/db/migration-033-exec.ts";
import { bootstrapOwner } from "../../src/auth/pairings.ts";
import type { AuthContext } from "../../src/auth/middleware.ts";
import type { SkillContent } from "../../src/skills/format.ts";

export function p1Database(maxVersion = 36) {
  const database = new Database(":memory:");
  database.run("PRAGMA foreign_keys=ON");
  database.run("CREATE TABLE schema_versions(version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT)");
  for (const name of readdirSync(new URL("../../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) {
    if (Number(name.slice(0, 3)) > maxVersion) continue;
    database.transaction(() => {
      for (const statement of splitSqlStatements(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"))) database.run(statement);
      database.query("INSERT OR IGNORE INTO schema_versions(version,description) VALUES (?,?)").run(Number(name.slice(0, 3)), name);
    })();
  }
  return database;
}
export function ownerFixture(schema=36) {
  const database = p1Database(schema);
  const owner = bootstrapOwner(database, "Fixture owner", "Fixture workspace");
  const auth = principalAuth(database, owner.agent_id);
  return { database, owner, auth };
}
export function principalAuth(database: Database, agentId: string): AuthContext {
  const p = database.query("SELECT * FROM agents WHERE id=?").get(agentId) as Record<string, unknown>;
  return { agent_id: String(p.id), workspace_id: String(p.workspace_id), agent_name: String(p.name), type: String(p.type),
    source: "api-key", tool_profile: String(p.tool_profile), policy_epoch: Number(p.policy_epoch), session_version: Number(p.session_version) };
}
export const completeContent: SkillContent = {
  title: "Validate a fixture", purpose: "Check a disposable local artifact", trigger: ["A fixture has changed"],
  inputs_schema: { type: "object" }, outputs_schema: { type: "object" }, procedure: ["Read the fixture"],
  verification: ["Compare its digest with the expected digest"], failure_modes: ["Missing fixture"], rollback: "Keep the previous fixture",
  compatibility: ["bun"], requested_capabilities: ["file_read"], secret_refs: [], redaction_report: [],
};
