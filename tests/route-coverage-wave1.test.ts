/**
 * F-090: negative-auth lock-in for the dashboard and API routes wave 0 did not cover.
 * One table of [method, path, credential, expected status]; each row fails if a guard
 * is dropped. Rows assert status codes only, never payload shapes (as in wave 0).
 *
 * Credentials: none, an ingest-daemon key (not a dashboard principal), a static key
 * where only the owner cookie is accepted, a standard agent reaching a sibling's data,
 * the owner reaching another workspace's ids, and cookie mutations without
 * X-Qoopia-CSRF or with a foreign Origin. OAuth-token rows live in
 * file-mutation-oauth / oauth-bridge-eligibility; consent rows in oauth-consent-bridge.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, setSharedContext } from "../src/admin/agents.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { fileUpload } from "../src/services/files.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { issueLocalLogin } from "../src/delivery/local-login.ts";
import { startHttpServer } from "../src/http.ts";
import { env } from "../src/utils/env.ts";
import { dashboardLimiter, globalLimiter } from "../src/utils/rate-limit.ts";

let server: Server;
let base = "";
const k = { owner: "", ownerId: "", steward: "", standard: "", standardId: "", siblingId: "", ingest: "", foreignAgentId: "" };
const ids = { ownFile: "", foreignFile: "", siblingSession: "", foreignSession: "" };
let cookie = "";

beforeAll(async () => {
  runMigrations();
  for (const limiter of [globalLimiter, dashboardLimiter]) limiter.resetForTests();
  const ws = createWorkspace({ name: "Wave1 Home", slug: "wave1-home" });
  const foreign = createWorkspace({ name: "Wave1 Foreign", slug: "wave1-foreign" });
  const owner = bootstrapOwner(db, "Wave1 owner", undefined, ws.id);
  k.owner = owner.api_key; k.ownerId = owner.agent_id;
  k.steward = createAgent({ name: "wave1-steward", workspaceSlug: ws.slug, type: "steward" }).api_key;
  const standard = createAgent({ name: "wave1-standard", workspaceSlug: ws.slug });
  k.standard = standard.api_key; k.standardId = standard.id;
  k.siblingId = createAgent({ name: "wave1-sibling", workspaceSlug: ws.slug }).id;
  // ADR-020: sibling data is shared context; with the toggle off the wall holds.
  setSharedContext({ workspace_id: ws.id, agent_id: k.standardId, enabled: false, actor_id: owner.agent_id });
  k.ingest = createAgent({ name: "wave1-ingest", workspaceSlug: ws.slug, type: "ingest-daemon" }).api_key;
  const foreignAgent = createAgent({ name: "wave1-foreign", workspaceSlug: foreign.slug });
  k.foreignAgentId = foreignAgent.id;
  const file = (workspace_id: string, agent: string) => fileUpload({ workspace_id, owner_agent_id: agent, uploaded_by_agent_id: agent, folder: "wave1", filename: randomUUID() + ".txt", mime: "text/plain", bytes: Buffer.from("x") });
  ids.ownFile = (await file(ws.id, owner.agent_id)).id;
  ids.foreignFile = (await file(foreign.id, foreignAgent.id)).id;
  ids.siblingSession = saveMessage({ workspace_id: ws.id, agent_id: k.siblingId, session_id: "wave1-sibling-session", role: "user", content: "sibling" }).session_id;
  ids.foreignSession = saveMessage({ workspace_id: foreign.id, agent_id: foreignAgent.id, session_id: "wave1-foreign-session", role: "user", content: "foreign" }).session_id;
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/dashboard/login`, { method: "POST", headers: { authorization: `Bearer ${k.owner}` } });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  for (const limiter of [globalLimiter, dashboardLimiter]) limiter.resetForTests();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Row = [method: string, path: () => string, headers: () => Record<string, string>, status: number];
const bearer = (key: () => string) => () => ({ authorization: `Bearer ${key()}` });
const none = () => ({});
const json = { "content-type": "application/json" };

async function check(rows: Row[]) {
  for (const [method, path, headers, status] of rows) {
    const r = await fetch(`${base}${path()}`, { method, headers: { ...json, ...headers() }, body: method === "GET" ? undefined : "{}" });
    expect(`${method} ${path()} -> ${r.status}`).toBe(`${method} ${path()} -> ${status}`);
  }
}

describe("F-090: negative auth on dashboard and API routes", () => {
  test("no credential, or an ingest-daemon key, is 401 on every dashboard read and write", async () => {
    const routes: Array<[string, () => string]> = [
      ["GET", () => "/api/dashboard/files"], ["GET", () => "/api/dashboard/files/folders"],
      ["GET", () => `/api/dashboard/files/${ids.ownFile}/download`], ["GET", () => "/api/dashboard/entities"],
      ["GET", () => "/api/dashboard/skills"], ["GET", () => "/api/dashboard/activity"], ["GET", () => "/api/dashboard/overview"],
      ["GET", () => `/api/dashboard/sessions/${ids.siblingSession}/messages`], ["GET", () => `/api/dashboard/agents/${k.siblingId}/contract`],
      ["GET", () => "/api/dashboard/memory-saves"], ["POST", () => "/api/dashboard/memory-saves/x"],
      ["POST", () => `/api/dashboard/agents/${k.siblingId}/memory-policy`], ["GET", () => "/api/dashboard/authority/capabilities"],
      ["POST", () => "/api/dashboard/files"], ["DELETE", () => `/api/dashboard/files/${ids.ownFile}`],
      ["POST", () => "/api/dashboard/oauth/clients"],
    ];
    await check(routes.flatMap(([method, path]) => [[method, path, none, 401], [method, path, bearer(() => k.ingest), 401]] as Row[]));
  });

  test("owner-cookie-only routes refuse a valid static key and no credential with 401", async () => {
    const rows: Row[] = [];
    for (const path of ["/api/dashboard/profile", "/api/dashboard/memory", "/api/dashboard/connections", "/api/dashboard/connection-setup", "/api/dashboard/bridges", "/api/dashboard/my-agent"])
      rows.push(["GET", () => path, none, 401], ["GET", () => path, bearer(() => k.owner), 401]);
    await check(rows);
  });

  test("/api/v1 without a Bearer is 401 (only the public part of /capabilities is anonymous)", async () => {
    await check([["GET", () => "/api/v1/skills", none, 401], ["POST", () => "/api/v1/agent-pairings", none, 401],
      ["GET", () => "/api/v1/skills", bearer(() => "q_not-a-key"), 401]]);
  });

  test("an agent with shared context off cannot reach a sibling's data or owner-only mutations", async () => {
    const standard = bearer(() => k.standard);
    await check([
      ["GET", () => `/api/dashboard/agents/${k.siblingId}/contract`, standard, 403],
      ["GET", () => `/api/dashboard/sessions/${ids.siblingSession}/messages`, standard, 403],
      ["GET", () => `/api/dashboard/agents/${k.standardId}/contract`, standard, 200],
      ["POST", () => "/api/dashboard/files", standard, 403],
      ["DELETE", () => `/api/dashboard/files/${ids.ownFile}`, standard, 403],
      ["POST", () => "/api/dashboard/oauth/clients", standard, 403],
      ["GET", () => "/api/dashboard/memory-saves", standard, 403],
      ["GET", () => "/api/dashboard/memory-saves", bearer(() => k.steward), 403],
      ["POST", () => `/api/dashboard/agents/${k.standardId}/shared-context`, () => ({ ...standard(), "x-qoopia-csrf": "1" }), 403],
      ["POST", () => `/api/dashboard/agents/${k.siblingId}/shared-context`, () => ({ authorization: `Bearer ${k.steward}`, "x-qoopia-csrf": "1" }), 403],
    ]);

  });

  test("another workspace's ids are 404 to this workspace's owner and steward, and nothing is deleted", async () => {
    const owner = bearer(() => k.owner), steward = bearer(() => k.steward);
    await check([
      ["GET", () => `/api/dashboard/files/${ids.foreignFile}/download`, owner, 404],
      ["DELETE", () => `/api/dashboard/files/${ids.foreignFile}`, owner, 404],
      ["GET", () => `/api/dashboard/agents/${k.foreignAgentId}/contract`, steward, 404],
      ["GET", () => `/api/dashboard/sessions/${ids.foreignSession}/messages`, steward, 404],
    ]);
    expect(db.query("SELECT 1 FROM files WHERE id=?").get(ids.foreignFile)).toBeTruthy();
  });

  test("cookie mutations need X-Qoopia-CSRF and the dashboard Origin", async () => {
    const routes = ["/api/dashboard/memory", "/api/dashboard/connection-setup", "/api/dashboard/bridges", "/api/dashboard/my-agent",
      "/api/dashboard/authority/notes", "/api/dashboard/memory-saves/x", `/api/dashboard/agents/${k.ownerId}/memory-policy`,
      "/api/dashboard/files", "/api/dashboard/oauth/clients", "/api/dashboard/logout"];
    const rows: Row[] = [];
    for (const path of routes) {
      rows.push(["POST", () => path, () => ({ cookie, origin: base }), 403]);
      rows.push(["POST", () => path, () => ({ cookie, origin: "https://evil.example", "x-qoopia-csrf": "1" }), 403]);
    }
    await check(rows);
  });
});

describe("F-090: standalone gates", () => {
  const previous = { port: env.PORT, standalone: process.env.QOOPIA_STANDALONE };
  let standalone: Server;
  let local = "";
  beforeAll(async () => {
    process.env.QOOPIA_STANDALONE = "true";
    env.PORT = 0;
    standalone = startHttpServer();
    await new Promise<void>((resolve, reject) => { standalone.once("listening", resolve); standalone.once("error", reject); });
    env.PORT = (standalone.address() as { port: number }).port;
    local = `http://127.0.0.1:${env.PORT}`;
  });
  afterAll(async () => {
    standalone.closeAllConnections();
    await new Promise<void>((resolve) => standalone.close(() => resolve()));
    env.PORT = previous.port;
    if (previous.standalone === undefined) delete process.env.QOOPIA_STANDALONE; else process.env.QOOPIA_STANDALONE = previous.standalone;
  });

  test("a foreign Host is refused before any route", async () => {
    const r = await fetch(`${local}/api/dashboard/agents`, { headers: { host: "rebind.example" } });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "Host refused" });
  });

  test("local-login needs a same-origin POST and a live code", async () => {
    const post = (origin: string | null, code: string) => fetch(`${local}/api/dashboard/local-login`, {
      method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ code }) });
    expect((await fetch(`${local}/api/dashboard/local-login`)).status).toBe(403);
    expect((await post(null, issueLocalLogin(k.ownerId))).status).toBe(403);
    expect((await post("https://evil.example", issueLocalLogin(k.ownerId))).status).toBe(403);
    expect((await post(local, "0".repeat(32))).status).toBe(401);
  });

  test("identity routes are 404 when owner sign-in is off on a hosted server", async () => {
    const standaloneFlag = process.env.QOOPIA_STANDALONE;
    delete process.env.QOOPIA_STANDALONE;
    try {
      expect((await fetch(`${base}/api/dashboard/identity/start`, { method: "POST", headers: { ...json, "x-qoopia-csrf": "1" }, body: "{}" })).status).toBe(404);
    } finally { process.env.QOOPIA_STANDALONE = standaloneFlag; }
  });
});
