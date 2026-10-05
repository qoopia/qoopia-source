// OWNER DECISION 2026-10-04 (ADR-020, F-335): shared context is read-only. A sibling with the
// toggle on reads a neighbour's note but cannot change, supersede or delete it; the author, the
// steward and the owner keep full rights; toggle off and private notes stay as they were.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { createNote, getNote } from "../src/services/notes.ts";
import { fail, findTool } from "../src/mcp/tools.ts";
import { enabledV4Tools } from "../src/mcp/v4-tools.ts";
import { startHttpServer } from "../src/http.ts";
import { QoopiaError } from "../src/utils/errors.ts";

let server: Server, base = "", ws = "", bobKey = "";
const id: Record<string, string> = {};
const as = (who: string, type = "standard") =>
  ({ agent_id: id[who]!, agent_name: `ro-${who}`, workspace_id: ws, type, source: "api-key" }) as AuthContext;
const aliceNote = (text = "readonly alice note", extra: Record<string, unknown> = {}) =>
  createNote({ workspace_id: ws, agent_id: id.alice!, text, type: "memory", ...extra });
const mcp = (name: string) => findTool(name) ?? enabledV4Tools().find((t) => t.name === name)!;
function code(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as QoopiaError).code; }
  return "OK";
}

beforeAll(async () => {
  runMigrations();
  const w = createWorkspace({ name: "Shared context read-only", slug: "adr020-read-only" });
  ws = w.id;
  for (const [name, type] of [["owner", "owner"], ["steward", "steward"], ["alice", "standard"], ["bob", "standard"], ["carl", "standard"]] as const) {
    const a = createAgent({ name: `ro-${name}`, workspaceSlug: w.slug, type });
    id[name] = a.id;
    if (name === "bob") bobKey = a.api_key;
  }
  const carl = db.query("SELECT metadata FROM agents WHERE id=?").get(id.carl!) as { metadata: string };
  db.query("UPDATE agents SET metadata=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(carl.metadata || "{}"), shared_context: false }), id.carl!);
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
  delete process.env.QOOPIA_V4_RELATIONS;
});

describe("a shared-context neighbour reads but cannot change", () => {
  test("note_get works; note_update and note_delete are FORBIDDEN with the author and the next action", () => {
    const n = aliceNote();
    expect((mcp("note_get").handler({ id: n.id }, as("bob")) as { text: string }).text).toBe("readonly alice note");
    let caught: unknown;
    try { mcp("note_update").handler({ id: n.id, text: "bob rewrote it" }, as("bob")); } catch (error) { caught = error; }
    expect((caught as QoopiaError).code).toBe("FORBIDDEN");
    expect((caught as QoopiaError).details?.next_action).toBe("Ask ro-alice or the steward to change it, or add your own note.");
    expect(fail(caught).content[0]!.text).toMatch(/^FORBIDDEN: note .* belongs to ro-alice; shared context is read-only\. Ask ro-alice or the steward/);
    expect(code(() => mcp("note_update").handler({ id: n.id, tags: ["bob"] }, as("bob")))).toBe("FORBIDDEN");
    expect(code(() => mcp("note_update").handler({ id: n.id, metadata: { status: "done" } }, as("bob")))).toBe("FORBIDDEN");
    expect(code(() => mcp("note_delete").handler({ id: n.id }, as("bob")))).toBe("FORBIDDEN");
    const after = getNote(ws, n.id, id.alice!, false);
    expect(after.text).toBe("readonly alice note");
    expect(after.tags).toEqual([]);
  });

  test("note_supersede (legacy and bitemporal) and note_create(supersedes_id) cannot archive a neighbour's note", async () => {
    process.env.QOOPIA_V4_RELATIONS = "true";
    const target = aliceNote("readonly alice old fact");
    const mine = createNote({ workspace_id: ws, agent_id: id.bob!, text: "bob new fact", type: "memory" });
    const supersede = (key: string) => mcp("note_supersede").handler({
      source_note_id: mine.id, target_note_id: target.id,
      expected_target_updated_at_ms: target.updated_at_ms, idempotency_key: key,
    }, as("bob"));
    expect(code(() => supersede("ro-legacy-supersede"))).toBe("FORBIDDEN");
    process.env.QOOPIA_V4_BITEMPORAL = "1";
    expect(code(() => supersede("ro-temporal-supersede"))).toBe("FORBIDDEN");
    expect(code(() => createNote({
      workspace_id: ws, agent_id: id.bob!, text: "bob replaces alice", type: "memory", is_admin: false,
      supersedes_id: target.id, expected_superseded_updated_at_ms: target.updated_at_ms,
    }))).toBe("FORBIDDEN");
    const row = db.query("SELECT metadata, invalidated_at_ms FROM notes WHERE id=?").get(target.id) as { metadata: string; invalidated_at_ms: number | null };
    expect(row.invalidated_at_ms).toBeNull();
    expect(JSON.parse(row.metadata)).not.toHaveProperty("superseded_by");
  });

  test("the dashboard shows the neighbour's notes and gives a neighbour no write route", async () => {
    const n = aliceNote("readonly alice dashboard note");
    const read = await fetch(`${base}/api/dashboard/agents/${id.alice}/notes`, { headers: { authorization: `Bearer ${bobKey}` } });
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain(n.id);
    const write = await fetch(`${base}/api/dashboard/v4/lifecycle-confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobKey}`, "content-type": "application/json", "x-qoopia-csrf": "1" },
      body: JSON.stringify({ note_id: n.id }),
    });
    // V4 review writes are owner/steward only (403), or not served at all (404) when disabled.
    expect([403, 404]).toContain(write.status);
    expect(db.query("SELECT 1 FROM memory_lifecycle WHERE note_id=?").get(n.id)).toBeNull();
  });
});

describe("author, steward and owner keep full rights", () => {
  test("the author updates and deletes its own note", () => {
    const n = aliceNote();
    expect(mcp("note_update").handler({ id: n.id, text: "alice edit" }, as("alice"))).toMatchObject({ updated: true });
    expect(mcp("note_delete").handler({ id: n.id }, as("alice"))).toMatchObject({ deleted: true });
  });

  test("the steward and the owner update, supersede and delete any workspace note, private included", () => {
    for (const who of ["steward", "owner"] as const) {
      const shared = aliceNote(`readonly ${who} shared`);
      const priv = aliceNote(`readonly ${who} private`, { visibility: "private" });
      expect(mcp("note_update").handler({ id: shared.id, text: `${who} edit`, tags: [who] }, as(who, who))).toMatchObject({ updated: true });
      expect(mcp("note_update").handler({ id: priv.id, text: `${who} edit` }, as(who, who))).toMatchObject({ updated: true });
      expect(mcp("note_delete").handler({ id: shared.id }, as(who, who))).toMatchObject({ deleted: true });
      expect(mcp("note_delete").handler({ id: priv.id }, as(who, who))).toMatchObject({ deleted: true });
    }
    process.env.QOOPIA_V4_RELATIONS = "true";
    const old = aliceNote("readonly steward old");
    const head = createNote({ workspace_id: ws, agent_id: id.steward!, text: "steward head", type: "memory" });
    expect(mcp("note_supersede").handler({
      source_note_id: head.id, target_note_id: old.id,
      expected_target_updated_at_ms: old.updated_at_ms, idempotency_key: "ro-steward-supersede",
    }, as("steward", "steward"))).toMatchObject({ target_archived: true });
  });
});

describe("unchanged: toggle off and private notes", () => {
  test("toggle off cannot even read a neighbour's note: NOT_FOUND everywhere", () => {
    const n = aliceNote();
    expect(code(() => mcp("note_get").handler({ id: n.id }, as("carl")))).toBe("NOT_FOUND");
    expect(code(() => mcp("note_update").handler({ id: n.id, text: "carl" }, as("carl")))).toBe("NOT_FOUND");
    expect(code(() => mcp("note_delete").handler({ id: n.id }, as("carl")))).toBe("NOT_FOUND");
  });

  test("a neighbour's private note stays invisible: NOT_FOUND, never FORBIDDEN", () => {
    const n = aliceNote("readonly alice private", { visibility: "private" });
    expect(code(() => mcp("note_get").handler({ id: n.id }, as("bob")))).toBe("NOT_FOUND");
    expect(code(() => mcp("note_update").handler({ id: n.id, text: "bob" }, as("bob")))).toBe("NOT_FOUND");
    expect(code(() => mcp("note_delete").handler({ id: n.id }, as("bob")))).toBe("NOT_FOUND");
  });
});
