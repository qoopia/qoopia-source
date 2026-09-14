/**
 * QSEC-001 regression: standard agent keys must not read sibling-agent data
 * via /api/dashboard/*. Steward keys still see the whole workspace.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { createNote } from "../src/services/notes.ts";

let server: Server;
let baseUrl = "";

let WORKSPACE_ID = "";
let AGENT_A_ID = "";
let AGENT_A_KEY = "";
let AGENT_B_ID = "";
let AGENT_B_KEY = "";
let STEWARD_ID = "";
let STEWARD_KEY = "";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Scope Test", slug: "scope-test" });
  WORKSPACE_ID = ws.id;

  const a = createAgent({ name: "scope-a", workspaceSlug: ws.slug });
  AGENT_A_ID = a.id;
  AGENT_A_KEY = a.api_key;

  const b = createAgent({ name: "scope-b", workspaceSlug: ws.slug });
  AGENT_B_ID = b.id;
  AGENT_B_KEY = b.api_key;

  const steward = createAgent({
    name: "scope-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  });
  STEWARD_ID = steward.id;
  STEWARD_KEY = steward.api_key;

  // Seed a note on agent B that A must NOT see.
  createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_B_ID,
    text: "private to B",
    type: "memory",
  });

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string, token: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("QSEC-001: dashboard scope", () => {
  test("standard agent A sees ONLY itself in /agents", async () => {
    const r = await get("/api/dashboard/agents", AGENT_A_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.id).toBe(AGENT_A_ID);
  });

  test("standard agent A is FORBIDDEN to read agent B's notes", async () => {
    const r = await get(`/api/dashboard/agents/${AGENT_B_ID}/notes`, AGENT_A_KEY);
    expect(r.status).toBe(403);
  });

  test("standard agent A is FORBIDDEN to read agent B's sessions", async () => {
    const r = await get(
      `/api/dashboard/agents/${AGENT_B_ID}/sessions`,
      AGENT_A_KEY,
    );
    expect(r.status).toBe(403);
  });

  test("standard agent A is FORBIDDEN to search agent B's messages", async () => {
    const r = await get(
      `/api/dashboard/agents/${AGENT_B_ID}/search?q=hello`,
      AGENT_A_KEY,
    );
    expect(r.status).toBe(403);
  });

  test("standard agent A CAN read its own notes", async () => {
    const r = await get(`/api/dashboard/agents/${AGENT_A_ID}/notes`, AGENT_A_KEY);
    expect(r.status).toBe(200);
  });

  test("steward sees the whole workspace in /agents", async () => {
    const r = await get("/api/dashboard/agents", STEWARD_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(AGENT_A_ID);
    expect(ids).toContain(AGENT_B_ID);
    expect(ids).toContain(STEWARD_ID);
  });

  test("steward CAN read agent B's notes", async () => {
    const r = await get(`/api/dashboard/agents/${AGENT_B_ID}/notes`, STEWARD_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ text: string }> };
    expect(body.items.some((n) => n.text === "private to B")).toBe(true);
  });
});
