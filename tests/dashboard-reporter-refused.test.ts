/**
 * F-520-reporter-dashboard: a runtime reporter is a 'standard' agent row with principal_kind 'reporter'
 * and no memory authority (auth/policy.ts refuses it on MCP and REST). The dashboard only checked the
 * type, so its API key read the workspace's shared notes and transcripts through /api/dashboard/*.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { createNote } from "../src/services/notes.ts";
import { DASHBOARD_COOKIE, signSession } from "../src/dashboard-session.ts";
import { dashboardLimiter } from "../src/utils/rate-limit.ts";

let server: Server;
let base = "";
let reporter: { id: string; api_key: string };
let sibling: { id: string; api_key: string };

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Reporter refusal", slug: "reporter-refusal" });
  sibling = createAgent({ name: "reporter-refusal-sibling", workspaceSlug: ws.slug });
  createNote({ workspace_id: ws.id, agent_id: sibling.id, text: "Synthetic sibling memory", type: "memory" });
  reporter = createAgent({ name: "reporter-refusal-runtime", workspaceSlug: ws.slug });
  db.query("UPDATE agents SET principal_kind='reporter', authority_profile='runtime-reporter', tool_profile='read-only' WHERE id=?").run(reporter.id);
  server = startHttpServer();
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("a runtime reporter's key and cookie are not dashboard credentials", async () => {
  dashboardLimiter.resetForTests();
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  expect((await fetch(`${base}/api/dashboard/agents/${sibling.id}/notes`, { headers: bearer(sibling.api_key) })).status).toBe(200);
  for (const path of [`/api/dashboard/agents/${sibling.id}/notes`, "/api/dashboard/search?q=Synthetic", "/api/dashboard/agents"]) {
    expect((await fetch(base + path, { headers: bearer(reporter.api_key) })).status).toBe(401);
  }
  expect((await fetch(`${base}/api/dashboard/login`, { method: "POST", headers: bearer(reporter.api_key) })).status).toBe(401);
  const sv = (db.query("SELECT session_version FROM agents WHERE id=?").get(reporter.id) as { session_version: number }).session_version;
  const cookie = `${DASHBOARD_COOKIE}=${signSession(reporter.id, sv)}`;
  expect((await fetch(`${base}/api/dashboard/search?q=Synthetic`, { headers: { cookie } })).status).toBe(401);
});
