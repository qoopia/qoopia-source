import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrations = join(import.meta.dir, "..", "migrations");

describe("AgentComm Phase 3 migration", () => {
  test("026 forward and rollback round-trip on a scratch database", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_versions (
          version INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
        CREATE TABLE workspaces (id TEXT PRIMARY KEY);
        CREATE TABLE agents (id TEXT PRIMARY KEY);
      `);
      db.exec(readFileSync(join(migrations, "014-agent-comm.sql"), "utf8"));
      db.exec(readFileSync(join(migrations, "026-phase3-agentcomm-integrity.sql"), "utf8"));

      const messageColumns = db.query("PRAGMA table_info(agent_comm_messages)").all() as
        Array<{ name: string }>;
      const wakeColumns = db.query("PRAGMA table_info(agent_wake_events)").all() as
        Array<{ name: string }>;
      expect(messageColumns.some((column) => column.name === "idempotency_key")).toBe(true);
      expect(wakeColumns.some((column) => column.name === "attempt_count")).toBe(true);

      db.exec(readFileSync(
        join(migrations, "rollback", "026-phase3-agentcomm-integrity.rollback.sql"),
        "utf8",
      ));
      const rolledBackMessageColumns = db
        .query("PRAGMA table_info(agent_comm_messages)")
        .all() as Array<{ name: string }>;
      const rolledBackWakeColumns = db
        .query("PRAGMA table_info(agent_wake_events)")
        .all() as Array<{ name: string }>;
      expect(
        rolledBackMessageColumns.some((column) => column.name === "idempotency_key"),
      ).toBe(false);
      expect(
        rolledBackWakeColumns.some((column) => column.name === "attempt_count"),
      ).toBe(false);
      expect(
        db.query("SELECT 1 FROM schema_versions WHERE version = 26").get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
});
