// F-304 / F-311: dashboard Search is one server-side request over the notes and
// messages the caller may open, paged with cursors, instead of downloading every
// agent's 500 newest notes and filtering them in the browser.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, setSharedContext } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { createNote } from "../src/services/notes.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { dashboardScript } from "./helpers/dashboard-source.ts";

let server: Server;
let baseUrl = "";
const key: Record<string, string> = {};
const id: Record<string, string> = {};
let wsId = "";

type Hit = { kind: string; id: string | number; agent_id: string; agent_name: string; created_at: string; excerpt: string };
type Page = { items: Hit[]; next: { messages_before: string | null; notes_before: string | null } | null };

const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Dashboard search", slug: "dashboard-search" });
  wsId = ws.id;
  const ws2 = createWorkspace({ name: "Dashboard search elsewhere", slug: "dashboard-search-elsewhere" });
  for (const [name, slug, type] of [["steward", ws.slug, "steward"], ["a", ws.slug, undefined], ["b", ws.slug, undefined],
    ["gone", ws.slug, undefined], ["other", ws2.slug, "steward"]] as const) {
    const agent = createAgent({ name: "ds-" + name, workspaceSlug: slug, ...(type ? { type } : {}) });
    key[name] = agent.api_key;
    id[name] = agent.id;
  }
  const note = (agent: string, text: string, i: number, extra = {}) => {
    const n = createNote({ workspace_id: agent === "other" ? ws2.id : ws.id, agent_id: id[agent]!, type: "note", text, ...extra });
    db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(at(i), n.id);
  };
  // 600 notes; the oldest one carries the token. A notes list stops at the newest 500.
  for (let i = 0; i < 600; i++) note("a", i === 0 ? "zebraquartz is the oldest synthetic note" : `synthetic note ${i}`, i * 2);
  for (let i = 0; i < 50; i++) {
    const m = saveMessage({ session_id: "ds-session", workspace_id: ws.id, agent_id: id.a!, role: "user", content: `synthetic message ${i}${i === 7 ? " zebraquartz" : ""}` });
    db.prepare("UPDATE session_messages SET created_at = ? WHERE id = ?").run(at(i * 20 + 1), m.id);
  }
  note("a", "x ".repeat(2500) + "needleword " + "y ".repeat(7000), 2000);
  note("b", "privatetoken of b", 2001, { visibility: "private" });
  note("gone", "gonetoken", 2002);
  db.prepare("UPDATE agents SET active = 0 WHERE id = ?").run(id.gone!);
  note("other", "zebraquartz in another workspace", 2003);
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function search(who: string | null, q: string, extra = "") {
  const r = await fetch(`${baseUrl}/api/dashboard/search?q=${encodeURIComponent(q)}${extra}`, {
    headers: who ? { authorization: `Bearer ${key[who]}` } : {},
  });
  const text = await r.text();
  return { status: r.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) as Page };
}

test("Search needs a dashboard session", async () => {
  expect((await search(null, "zebraquartz")).status).toBe(401);
});

test("finds the oldest of 600 notes and the message in one bounded response", async () => {
  const { status, bytes, body } = await search("steward", "zebraquartz");
  expect(status).toBe(200);
  expect(body.items.map((h) => h.kind).sort()).toEqual(["message", "note"]);
  const hit = body.items.find((h) => h.kind === "note")!;
  expect(hit.excerpt).toContain("zebraquartz");
  expect(hit.agent_name).toBe("ds-a");
  expect(bytes).toBeLessThan(50_000);
});

test("another workspace sees only its own rows", async () => {
  const { body } = await search("other", "zebraquartz");
  expect(body.items.length).toBe(1);
  expect(body.items[0]!.agent_id).toBe(id.other!);
});

test("ADR-020: shared context searches siblings, off searches only itself; private notes stay with their author", async () => {
  expect((await search("b", "zebraquartz")).body.items.length).toBe(2);
  expect((await search("b", "privatetoken")).body.items.length).toBe(1);
  expect((await search("a", "privatetoken")).body.items).toEqual([]);
  // The steward sees what the Notes tab already shows it.
  expect((await search("steward", "privatetoken")).body.items.length).toBe(1);
  setSharedContext({ workspace_id: wsId, agent_id: id.b!, enabled: false, actor_id: id.steward! });
  try {
    expect((await search("b", "zebraquartz")).body.items).toEqual([]);
    expect((await search("b", "privatetoken")).body.items.length).toBe(1);
  } finally {
    setSharedContext({ workspace_id: wsId, agent_id: id.b!, enabled: true, actor_id: id.steward! });
  }
});

test("deactivated agents are not searched, as they are not listed", async () => {
  expect((await search("steward", "gonetoken")).body.items).toEqual([]);
});

test("pages through every match newest first without gaps or repeats", async () => {
  const seen: Hit[] = [];
  let next: Page["next"] = null, pages = 0;
  do {
    const cursor = next ? `&messages_before=${encodeURIComponent(next.messages_before ?? "")}&notes_before=${encodeURIComponent(next.notes_before ?? "")}` : "";
    const { status, body } = await search("steward", "synthetic", "&limit=100" + cursor);
    expect(status).toBe(200);
    seen.push(...body.items);
    next = body.next;
    pages++;
  } while (next && pages < 20);
  expect(pages).toBe(7);
  expect(new Set(seen.map((h) => h.kind + ":" + h.id)).size).toBe(650);
  expect(seen.length).toBe(650);
  expect(seen.every((h, i) => i === 0 || seen[i - 1]!.created_at >= h.created_at)).toBe(true);
  expect(seen.at(-1)!.excerpt).toContain("zebraquartz");
});

test("an excerpt is centred on the match and bounded", async () => {
  const { body } = await search("steward", "needleword");
  expect(body.items[0]!.excerpt).toContain("needleword");
  expect(body.items[0]!.excerpt.length).toBeLessThanOrEqual(310);
});

test("a cursor this endpoint did not return is refused", async () => {
  expect((await search("steward", "synthetic", "&notes_before=a|b|c")).status).toBe(400);
});

test("the dashboard asks once per query and never downloads note lists to filter them", () => {
  const start = dashboardScript.indexOf("  async function doGlobalSearch(q) {");
  const body = dashboardScript.slice(start, dashboardScript.indexOf("\n  }\n", start));
  expect(body).toContain("/api/dashboard/search?");
  expect(body).not.toContain("/notes?");
  expect(body.match(/\bapi\(/g)?.length).toBe(1);
});

// F-312: the Notes tab reaches every note its badge counts, not only the newest 500.
test("the notes list pages past the newest 500 to the oldest note", async () => {
  const seen = new Set<string>();
  let before = "", pages = 0, oldest = false;
  do {
    const r = await fetch(`${baseUrl}/api/dashboard/agents/${id.a}/notes?limit=200${before ? "&before=" + encodeURIComponent(before) : ""}`, {
      headers: { authorization: `Bearer ${key.steward}` },
    });
    const body = (await r.json()) as { items: Array<{ id: string; text: string }>; next_before: string | null };
    for (const n of body.items) { seen.add(n.id); oldest ||= n.text.includes("zebraquartz"); }
    before = body.next_before ?? "";
    pages++;
  } while (before && pages < 10);
  expect(seen.size).toBe(601);
  expect(oldest).toBe(true);
  expect(pages).toBe(4);
  const bad = await fetch(`${baseUrl}/api/dashboard/agents/${id.a}/notes?before=a|b|c`, { headers: { authorization: `Bearer ${key.steward}` } });
  expect(bad.status).toBe(400);
});
