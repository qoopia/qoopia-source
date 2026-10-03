// ADR-020: the owner switches an agent's shared context in the dashboard, the steward over MCP.
// Both are audited, take effect at once, and the dashboard reads follow the same rule as MCP.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { legacyPrivilegedAgent } from "./helpers/legacy-agent.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { sharesContext } from "../src/auth/principal.ts";
import { adminTools } from "../src/mcp/admin-tools.ts";
import { createNote } from "../src/services/notes.ts";
import { createNoteProvenance } from "../src/services/provenance.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { startHttpServer } from "../src/http.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

let server: Server, base = "", ws = "", ownerKey = "", stewardKey = "", bobKey = "", carlKey = "";
const id: Record<string, string> = {};

beforeAll(async () => {
  runMigrations();
  const w = createWorkspace({ name: "Shared context toggle", slug: "adr020-toggle" });
  ws = w.id;
  const owner = bootstrapOwner(db, "adr020 toggle owner", undefined, ws);
  id.owner = owner.agent_id;
  ownerKey = owner.api_key;
  for (const [name, type] of [["steward", "steward"], ["alice", "standard"], ["bob", "standard"], ["carl", "standard"], ["priv", "claude-privileged"]] as const) {
    const a = type === "claude-privileged"
      ? legacyPrivilegedAgent(`toggle-${name}`, w.slug)
      : createAgent({ name: `toggle-${name}`, workspaceSlug: w.slug, type });
    id[name] = a.id;
    if (name === "steward") stewardKey = a.api_key;
    if (name === "bob") bobKey = a.api_key;
    if (name === "carl") carlKey = a.api_key;
  }
  const o = createWorkspace({ name: "Shared context toggle other", slug: "adr020-toggle-other" });
  id.otherWs = o.id;
  id.foreignSteward = createAgent({ name: "toggle-foreign-steward", workspaceSlug: o.slug, type: "steward" }).id;
  createNote({ workspace_id: ws, agent_id: id.alice!, text: "quasarword alice shared" });
  createNote({ workspace_id: ws, agent_id: id.alice!, text: "quasarword alice private", visibility: "private" });
  saveMessage({ session_id: "toggle-alice", workspace_id: ws, agent_id: id.alice!, role: "user", content: "quasarword alice message" });
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const tool = adminTools.find((t) => t.name === "agent_set_shared_context")!;
const as = (who: string, type: string, workspace = ws) =>
  ({ agent_id: id[who]!, agent_name: who, workspace_id: workspace, type, source: "api-key" }) as AuthContext;
const audits = (target: string) =>
  (db.query("SELECT COUNT(*) AS n FROM activity WHERE action='agent_shared_context_changed' AND entity_id=?").get(target) as { n: number }).n;
const metadata = (agent: string) => JSON.parse((db.query("SELECT metadata FROM agents WHERE id=?").get(agent) as { metadata: string }).metadata);

describe("steward MCP switch", () => {
  test("every agent starts on; the steward switches by name, audited once, idempotent", () => {
    expect(sharesContext(id.carl!)).toBe(true);
    expect(metadata(id.carl!)).not.toHaveProperty("shared_context");
    expect(tool.handler({ agent: "toggle-carl", enabled: false }, as("steward", "steward"))).toMatchObject({ agent_id: id.carl, shared_context: false, changed: true });
    expect(metadata(id.carl!).shared_context).toBe(false);
    expect(sharesContext(id.carl!)).toBe(false);
    expect(tool.handler({ agent: id.carl!, enabled: false }, as("steward", "steward"))).toMatchObject({ changed: false });
    expect(audits(id.carl!)).toBe(1);
    expect(tool.risk).toBe("admin");
  });

  test("ordinary agents, claude-privileged and another workspace's steward cannot switch it", () => {
    expect(() => tool.handler({ agent: "toggle-carl", enabled: true }, as("bob", "standard"))).toThrow(/steward or owner/);
    expect(() => tool.handler({ agent: "toggle-carl", enabled: true }, as("priv", "claude-privileged"))).toThrow(/steward or owner/);
    expect(() => tool.handler({ agent: id.carl!, enabled: true }, as("foreignSteward", "steward", id.otherWs))).toThrow();
    expect(sharesContext(id.carl!)).toBe(false);
  });

  test("the steward and the owner have no toggle: they always read the whole workspace", () => {
    expect(() => tool.handler({ agent: id.owner!, enabled: false }, as("steward", "steward"))).toThrow(/always read the whole workspace/);
    expect(() => tool.handler({ agent: "toggle-steward", enabled: false }, as("steward", "steward"))).toThrow(/always read the whole workspace/);
  });
});

const post = (key: string, agent: string, body: unknown, headers: Record<string, string> = { "x-qoopia-csrf": "1" }) =>
  fetch(`${base}/api/dashboard/agents/${agent}/shared-context`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const get = async (key: string, path: string) => {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
type Row = { id: string; shared_context: boolean | null; text?: string; excerpt?: string };
const items = (body: Record<string, unknown>) => (body.items ?? []) as Row[];

describe("owner dashboard switch", () => {
  test("only the owner, with Origin and X-Qoopia-CSRF, switches it; the card shows it", async () => {
    expect((await post(ownerKey, id.bob!, { enabled: false }, {})).status).toBe(403);
    expect((await post(ownerKey, id.bob!, { enabled: false }, { "x-qoopia-csrf": "1", origin: "https://evil.example.com" })).status).toBe(403);
    expect((await post(stewardKey, id.bob!, { enabled: false })).status).toBe(403);
    expect((await post(bobKey, id.bob!, { enabled: false })).status).toBe(403);
    expect((await post(ownerKey, id.bob!, { enabled: "no" })).status).toBe(400);
    expect((await post(ownerKey, id.steward!, { enabled: false })).status).toBe(400);
    expect(sharesContext(id.bob!)).toBe(true);

    const off = await post(ownerKey, id.bob!, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ agent_id: id.bob, shared_context: false, changed: true });
    expect(audits(id.bob!)).toBe(1);
    const cards = items((await get(ownerKey, "/api/dashboard/agents")).body);
    expect(cards.find((a) => a.id === id.bob)!.shared_context).toBe(false);
    expect(cards.find((a) => a.id === id.alice)!.shared_context).toBe(true);
    expect(cards.find((a) => a.id === id.steward)!.shared_context).toBeNull();
    expect((await post(ownerKey, id.bob!, { enabled: true })).status).toBe(200);
  });
});

describe("dashboard reads follow the toggle", () => {
  test("shared context on: siblings, their notes and messages, never a private note", async () => {
    expect(items((await get(bobKey, "/api/dashboard/agents")).body).map((a) => a.id)).toContain(id.alice);
    const notes = await get(bobKey, `/api/dashboard/agents/${id.alice}/notes`);
    expect(notes.status).toBe(200);
    expect(items(notes.body).map((n) => n.text)).toEqual(["quasarword alice shared"]);
    const found = items((await get(bobKey, "/api/dashboard/search?q=quasarword")).body).map((r) => r.excerpt);
    expect(found).toContain("quasarword alice shared");
    expect(found).toContain("quasarword alice message");
    expect(found).not.toContain("quasarword alice private");
    expect((await get(bobKey, `/api/dashboard/agents/${id.alice}/sessions`)).status).toBe(200);
  });

  test("shared context off: only itself", async () => {
    expect(items((await get(carlKey, "/api/dashboard/agents")).body).map((a) => a.id)).toEqual([id.carl]);
    expect((await get(carlKey, `/api/dashboard/agents/${id.alice}/notes`)).status).toBe(403);
    expect((await get(carlKey, `/api/dashboard/agents/${id.alice}/sessions`)).status).toBe(403);
    expect(items((await get(carlKey, "/api/dashboard/search?q=quasarword")).body)).toEqual([]);
  });

  test("agent cards count only the notes the viewer may read", async () => {
    type Card = Row & { notes_count: number };
    const count = async (key: string) => (items((await get(key, "/api/dashboard/agents")).body) as Card[]).find((a) => a.id === id.alice)!.notes_count;
    expect(await count(bobKey)).toBe(1);
    expect(await count(ownerKey)).toBe(2);
  });

  test("the owner sees everything, the private note included", async () => {
    const texts = items((await get(ownerKey, `/api/dashboard/agents/${id.alice}/notes`)).body).map((n) => n.text).sort();
    expect(texts).toEqual(["quasarword alice private", "quasarword alice shared"]);
  });
});

describe("AgentComm provenance follows the toggle", () => {
  test("a sibling conversation is a citable source only while shared context is on", () => {
    db.query(`INSERT INTO agent_comm_sessions (id, workspace_id, topic, status, created_by_agent_id, metadata, created_at, updated_at)
      VALUES ('toggle-acs', ?, 'toggle', 'open', ?, '{}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(ws, id.alice!);
    db.query(`INSERT INTO agent_comm_messages (id, workspace_id, session_id, sender_agent_id, recipient_agent_id, kind, body, metadata, created_at)
      VALUES ('toggle-acm', ?, 'toggle-acs', ?, ?, 'request', 'sibling talk', '{}', '2026-10-01T00:00:00Z')`).run(ws, id.alice!, id.priv!);
    const cite = (who: string) => createNoteProvenance({
      auth: { ...as(who, "standard"), tool_profile: "full" },
      note_id: createNote({ workspace_id: ws, agent_id: id[who]!, text: `${who} cites a conversation` }).id,
      source_kind: "agentcomm_message", source_id: "toggle-acm", source_hash: "0".repeat(64), confidence: 1,
    });
    expect(cite("bob").created).toBe(true);
    expect(() => cite("carl")).toThrow(/not found/);
  });
});
