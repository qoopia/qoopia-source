// F-101: dashboard message search goes through the shared FTS5 builder.
// Bareword operators and punctuation-only tokens no longer zero the AND-join,
// a NUL is a separator, a non-numeric limit falls back to the default, and
// SQLite error text never reaches the client.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { saveMessage } from "../src/services/sessions.ts";

let server: Server;
let baseUrl = "";
let agentId = "";
let key = "";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Dashboard message search", slug: "dashboard-message-search" });
  const agent = createAgent({ name: "dms-agent", workspaceSlug: ws.slug });
  agentId = agent.id;
  key = agent.api_key;
  saveMessage({ session_id: "dms-session", workspace_id: ws.id, agent_id: agentId, role: "user", content: "delivery receipt And the parcel" });
  saveMessage({ session_id: "dms-session", workspace_id: ws.id, agent_id: agentId, role: "user", content: "delivery receipt only" });
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function search(q: string, extra = "") {
  const r = await fetch(`${baseUrl}/api/dashboard/agents/${agentId}/search?q=${encodeURIComponent(q)}${extra}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return { status: r.status, body: (await r.json()) as { total?: number; error_description?: string } };
}

test.each([
  ["delivery receipt", 2],
  ["delivery AND receipt", 2],
  ["delivery OR parcel", 1],
  ["delivery …", 2],
  ["delivery .", 2],
  ["…", 0],
  ["delivery\u0000receipt", 2],
])("search %p returns %p rows", async (q, total) => {
  const { status, body } = await search(q as string);
  expect(status).toBe(200);
  expect(body.total).toBe(total as number);
});

test("a non-numeric limit falls back to the default on every list route", async () => {
  expect((await search("delivery", "&limit=abc")).body.total).toBe(2);
  for (const path of [`/agents/${agentId}/sessions`, `/agents/${agentId}/notes`, `/sessions/dms-session/messages`]) {
    const r = await fetch(`${baseUrl}/api/dashboard${path}?limit=abc`, { headers: { authorization: `Bearer ${key}` } });
    expect(r.status).toBe(200);
  }
});
