// A4-06: a long session opened on its first 1000 messages, so the newest were never visible; the agent's
// session list stopped at 200. Both now open on the newest rows and page back with a cursor.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server, baseUrl = "", KEY = "", AGENT = "";
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Session pages", slug: "a406-session-pages" });
  const owner = bootstrapOwner(db, "A406 owner", undefined, ws.id);
  KEY = owner.api_key; AGENT = owner.agent_id;
  db.query("INSERT INTO sessions(id,workspace_id,agent_id,title) VALUES ('a406-long',?,?,'Long session')").run(ws.id, AGENT);
  const message = db.query("INSERT INTO session_messages(workspace_id,session_id,agent_id,role,content) VALUES (?,'a406-long',?,'user',?)");
  db.transaction(() => { for (let i = 1; i <= 1200; i++) message.run(ws.id, AGENT, "message " + i); })();
  const session = db.query("INSERT INTO sessions(id,workspace_id,agent_id,title,last_active) VALUES (?,?,?,?,?)");
  for (let i = 0; i < 5; i++) session.run("a406-s" + i, ws.id, AGENT, "S" + i, "2026-10-0" + (i + 1) + "T00:00:00.000Z");
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
const get = async (path: string) => (await fetch(baseUrl + "/api/dashboard" + path, { headers: { authorization: `Bearer ${KEY}` } })).json() as Promise<any>;

test("a 1200-message session opens on its newest 500 in reading order, then pages to the oldest", async () => {
  const first = await get("/sessions/a406-long/messages?limit=500");
  expect(first.count).toBe(1200);
  expect(first.messages.map((m: any) => m.content).slice(-1)).toEqual(["message 1200"]);
  expect(first.messages[0].content).toBe("message 701");
  const second = await get("/sessions/a406-long/messages?limit=500&before=" + first.next_before);
  expect(second.messages[0].content).toBe("message 201");
  const last = await get("/sessions/a406-long/messages?limit=500&before=" + second.next_before);
  expect(last.messages.map((m: any) => m.content)).toEqual(Array.from({ length: 200 }, (_, i) => "message " + (i + 1)));
  expect(last.next_before).toBeNull();
});

test("an agent's session list continues after its last row", async () => {
  const first = await get(`/agents/${AGENT}/sessions?limit=4`);
  expect(first.items.map((s: any) => s.title)).toEqual(["Long session", "S4", "S3", "S2"]);
  const rest = await get(`/agents/${AGENT}/sessions?limit=4&before=${encodeURIComponent(first.next_before)}`);
  expect(rest.items.map((s: any) => s.title)).toEqual(["S1", "S0"]);
});
