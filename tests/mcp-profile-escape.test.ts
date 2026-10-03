import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server, base = "", connection = "", legacy = "";
beforeAll(async () => {
  runMigrations();
  const w = createWorkspace({ name: "MCP profile escape", slug: "mcp-profile-escape" });
  const c = createAgent({ name: "mpe-connection", workspaceSlug: w.slug }) as { id: string; api_key: string };
  // What src/services/client-connections.ts gives every client connection.
  db.query("UPDATE agents SET tool_profile='read-only',authority_profile='memory-worker',legacy_skill_access=0 WHERE id=?").run(c.id);
  connection = c.api_key;
  legacy = (createAgent({ name: "mpe-legacy", workspaceSlug: w.slug }) as { api_key: string }).api_key;
  server = startHttpServer();
  await new Promise<void>(r => (server.listening ? r() : server.once("listening", () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

async function tools(key: string, query = "") {
  const r = await fetch(`${base}/mcp${query}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  const text = await r.text();
  const data = text.includes("data:") ? text.split("\n").find(l => l.startsWith("data:"))!.slice(5) : text;
  return (JSON.parse(data).result.tools as Array<{ name: string }>).map(t => t.name);
}

test("a URL parameter cannot widen a connection's stored access profile", async () => {
  const plain = await tools(connection), widened = await tools(connection, "?profile=full");
  expect(widened.sort()).toEqual(plain.sort());
  for (const name of ["file_get", "file_list", "activity_list", "agent_send"]) expect(widened).not.toContain(name);
});

test("principals that predate the access profiles keep the full catalogue", async () => {
  expect(await tools(legacy)).toContain("file_get");
});
