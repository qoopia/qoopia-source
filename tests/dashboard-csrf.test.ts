/**
 * F-089: a same-site page can send a no-cors POST that carries the SameSite=Strict
 * dashboard cookie with `Origin: null` (referrer policy no-referrer) or with no Origin,
 * but it cannot add a custom header. Every cookie-authenticated mutation therefore
 * needs X-Qoopia-CSRF: 1 on top of the Origin check: file upload and delete, OAuth
 * client registration and logout. A Bearer is never attached by the browser, so a
 * static-key caller needs no header.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server;
let baseUrl = "";
let OWNER_ID = "";
let OWNER_KEY = "";
let WS_ID = "";
let cookie = "";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "CSRF", slug: "f089-csrf" });
  WS_ID = ws.id;
  const owner = bootstrapOwner(db, "F089 owner", undefined, ws.id);
  OWNER_ID = owner.agent_id;
  OWNER_KEY = owner.api_key;
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${baseUrl}/api/dashboard/login`, { method: "POST", headers: { authorization: `Bearer ${OWNER_KEY}` } });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const files = () => db.query("SELECT id, content FROM files WHERE workspace_id=? ORDER BY id").all(WS_ID) as Array<{ id: string; content: Uint8Array }>;
const clients = () => (db.query("SELECT COUNT(*) AS c FROM oauth_clients WHERE workspace_id=?").get(WS_ID) as { c: number }).c;
const sessionVersion = () => (db.query("SELECT session_version FROM agents WHERE id=?").get(OWNER_ID) as { session_version: number }).session_version;
const upload = (headers: Record<string, string>, content = "planted") => {
  const form = new FormData();
  form.append("folder", "inbox");
  form.append("file", new File([content], "note.txt", { type: "text/plain" }));
  return fetch(`${baseUrl}/api/dashboard/files`, { method: "POST", headers, body: form });
};
const registerClient = (headers: Record<string, string>) => fetch(`${baseUrl}/api/dashboard/oauth/clients`, {
  method: "POST",
  headers: { "content-type": "text/plain", ...headers },
  body: JSON.stringify({ client_name: "f089-client", redirect_uris: ["https://example.com/f089"], token_endpoint_auth_method: "none" }),
});

describe("F-089: cookie mutations need X-Qoopia-CSRF", () => {
  for (const [label, origin] of [["Origin: null", { origin: "null" }], ["no Origin", {}]] as const) {
    test(`${label}: upload, delete, OAuth client registration and logout are refused and change nothing`, async () => {
      const ownerFile = await upload({ authorization: `Bearer ${OWNER_KEY}` }, "owner bytes");
      expect(ownerFile.status).toBe(200);
      const before = files();
      const forged = { cookie, ...origin };
      expect((await upload(forged)).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/dashboard/files/${before[0]!.id}`, { method: "DELETE", headers: forged })).status).toBe(403);
      expect(files()).toEqual(before);
      const clientsBefore = clients();
      expect((await registerClient(forged)).status).toBe(403);
      expect(clients()).toBe(clientsBefore);
      const version = sessionVersion();
      const logout = await fetch(`${baseUrl}/api/dashboard/logout`, { method: "POST", headers: forged });
      expect(logout.status).toBe(403);
      expect(logout.headers.get("set-cookie")).toBeNull();
      expect(sessionVersion()).toBe(version);
    });
  }

  test("the dashboard's own requests (same Origin + header) still work", async () => {
    const own = { cookie, origin: baseUrl, "x-qoopia-csrf": "1" };
    const uploaded = await upload(own);
    expect(uploaded.status).toBe(200);
    const id = ((await uploaded.json()) as { uploaded: Array<{ id: string }> }).uploaded[0]!.id;
    expect((await fetch(`${baseUrl}/api/dashboard/files/${id}`, { method: "DELETE", headers: own })).status).toBe(200);
    expect((await registerClient({ ...own, "content-type": "application/json" })).status).toBe(201);
    const version = sessionVersion();
    expect((await fetch(`${baseUrl}/api/dashboard/logout`, { method: "POST", headers: own })).status).toBe(200);
    expect(sessionVersion()).toBe(version + 1);
  });

  test("a static-key Bearer needs no header", async () => {
    expect((await upload({ authorization: `Bearer ${OWNER_KEY}` })).status).toBe(200);
  });
});
