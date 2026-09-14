import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.NODE_ENV !== "test") throw new Error("V4 CLI fixture smoke is test-only");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-v4-cli-smoke-"));
process.env.QOOPIA_DATA_DIR = path.join(root, "data");
process.env.QOOPIA_LOG_DIR = path.join(root, "logs");
process.env.QOOPIA_BACKUP_DIR = path.join(root, "backups");
process.env.QOOPIA_ADMIN_SECRET ||= "fixture-admin-secret";
process.env.QOOPIA_SESSION_SECRET ||= "fixture-session-secret";
process.env.QOOPIA_AUTO_EMBED = "false";

try {
  const [{ runMigrations }, { createWorkspace }, { createAgent }, { createNote }, { brief }, { recall }, { V4_TOOL_NAMES }, { closeDb }] = await Promise.all([
    import("../src/db/migrate.ts"),
    import("../src/admin/workspaces.ts"),
    import("../src/admin/agents.ts"),
    import("../src/services/notes.ts"),
    import("../src/services/brief.ts"),
    import("../src/services/recall.ts"),
    import("../src/mcp/v4-tools.ts"),
    import("../src/db/connection.ts"),
  ]);
  runMigrations();
  const workspace = createWorkspace({ name: "P05 CLI fixture", slug: "p05-cli-fixture" });
  const agent = createAgent({ name: "p05-cli", workspaceSlug: workspace.slug, type: "owner" });
  const created = createNote({
    workspace_id: workspace.id,
    agent_id: agent.id,
    text: "p05 CLI smoke canonical recall marker",
    type: "memory",
  });
  const briefResult = brief({
    workspace_id: workspace.id,
    caller_agent_id: agent.id,
    is_admin: true,
    limit_per_section: 2,
  });
  const recallResult = await recall({
    workspace_id: workspace.id,
    caller_agent_id: agent.id,
    is_admin: true,
    query: "canonical recall marker",
    mode: "fts5",
    limit: 5,
  });
  if (!recallResult.results.some((item) => item.id === created.id)) {
    throw new Error("v4-smoke recall did not return its fixture note");
  }
  console.log(JSON.stringify({
    status: "pass",
    operations: ["identity", "discovery", "brief", "recall", "note_round_trip", "scratch_cleanup"],
    discovered_v4_tools: V4_TOOL_NAMES.length,
    brief_sections: Object.keys(briefResult).length,
    recall_items: recallResult.results.length,
  }));
  closeDb();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
