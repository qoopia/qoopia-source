// A4-04: an agent signed in with its own key opened Bridges or External folder and read
// "Bridge action failed. Keep your invitation…" (400). Owner-only pages now answer 403 in words.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server, baseUrl = "", AGENT_KEY = "", STEWARD_KEY = "";
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Owner pages", slug: "a404-owner-pages" });
  bootstrapOwner(db, "A404 owner", undefined, ws.id);
  AGENT_KEY = createAgent({ name: "a404-agent", workspaceSlug: ws.slug }).api_key;
  STEWARD_KEY = createAgent({ name: "a404-steward", workspaceSlug: ws.slug, type: "steward" }).api_key;
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

async function cookieFor(key: string) {
  const r = await fetch(`${baseUrl}/api/dashboard/login`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

test("an agent's or steward's dashboard session gets 403 with a reason on every owner-only page", async () => {
  for (const key of [AGENT_KEY, STEWARD_KEY]) {
    const cookie = await cookieFor(key);
    for (const path of ["/api/dashboard/bridges", "/api/dashboard/memory", "/api/dashboard/connections", "/api/dashboard/my-agent"]) {
      const r = await fetch(baseUrl + path, { headers: { cookie } });
      expect(r.status, path).toBe(403);
      expect(((await r.json()) as { error_description: string }).error_description, path).toBe("Only the workspace owner can open this.");
    }
  }
});
