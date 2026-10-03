// F-168 / F-170: one FTS5 query builder for recall, session_search and entity search.
// A NUL byte must never reach MATCH (FTS5 ends a string at U+0000 and raises
// "unterminated string"), and a one-ideograph CJK query is a real search term.
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall, sanitizeFtsQuery } from "../src/services/recall.ts";
import { saveMessage, sessionSearch } from "../src/services/sessions.ts";
import { searchEntities, upsertEntity } from "../src/services/entities.ts";
import { QoopiaError } from "../src/utils/errors.ts";

let ws = "", agent = "";

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "FTS5 query builder", slug: "fts5-query-builder" });
  ws = w.id;
  agent = createAgent({ name: "fts5-builder-agent", workspaceSlug: w.slug }).id;
  createNote({ workspace_id: ws, agent_id: agent, type: "memory", text: "delivery receipt for the parcel" });
  createNote({ workspace_id: ws, agent_id: agent, type: "memory", text: "猫 lives in the garden" });
  saveMessage({ session_id: "fts5-builder-session", workspace_id: ws, agent_id: agent, role: "user", content: "delivery tracking" });
  upsertEntity({ workspace_id: ws, type: "service", slug: "fts5-cjk-cat", title: "猫", summary: "cat service" });
});

describe("control characters never reach MATCH (F-168)", () => {
  const nul = "deli\u0000very";
  test("sanitizeFtsQuery turns NUL into a separator", () => {
    expect(sanitizeFtsQuery(nul)).toBe('"deli"* OR "very"*');
  });
  test("recall, session_search and entity search answer instead of raising SQLiteError", async () => {
    const r = await recall({ workspace_id: ws, caller_agent_id: agent, is_admin: false, query: nul, mode: "fts5" });
    expect(r.results.map((row) => row.text)).toContain("delivery receipt for the parcel");
    expect(sessionSearch({ workspace_id: ws, agent_id: agent, query: nul }).results.map((row: { content: string }) => row.content))
      .toEqual(["delivery tracking"]);
    expect(() => searchEntities({ workspace_id: ws, query: nul })).not.toThrow();
  });
});

describe("term floor counts code points and keeps logographic terms (F-170)", () => {
  test("a single ideograph is a term", () => {
    expect(sanitizeFtsQuery("猫")).toBe('"猫"*');
  });
  test("a single non-CJK code point is still noise", () => {
    expect(() => sanitizeFtsQuery("𝐚")).toThrow(QoopiaError);
  });
  test("an unindexable token yields the explicit no-match expression, not a dead term", () => {
    expect(sanitizeFtsQuery("🚀")).toBe('""');
  });
  test("recall and entity search find a one-ideograph query", async () => {
    const r = await recall({ workspace_id: ws, caller_agent_id: agent, is_admin: false, query: "猫", mode: "fts5" });
    expect(r.results.map((row) => row.text)).toContain("猫 lives in the garden");
    expect(searchEntities({ workspace_id: ws, query: "猫" }).map((hit) => hit.slug)).toContain("fts5-cjk-cat");
  });
  test("an emoji-only recall is an empty result, not INVALID_INPUT", async () => {
    const r = await recall({ workspace_id: ws, caller_agent_id: agent, is_admin: false, query: "🚀", mode: "fts5" });
    expect(r.results).toEqual([]);
  });
});
