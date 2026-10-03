import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.ts";
import { startHttpServer } from "../src/http.ts";
import { env } from "../src/utils/env.ts";

// [F-196] A rejected credential on any non-/oauth route leaves one audit line.
let server: Server;
let baseUrl = "";
const auditPath = path.join(env.LOG_DIR, "audit.log");
const token = `q_${crypto.randomBytes(24).toString("base64url")}`;

beforeAll(async () => {
  runMigrations();
  server = startHttpServer();
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Status of one request plus the auth_failure rows it appended to audit.log. */
async function probe(pathname: string, init: RequestInit = {}) {
  const offset = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0;
  const response = await fetch(baseUrl + pathname, init);
  await response.text();
  await Bun.sleep(50); // the hook runs on the server's "finish" event
  const appended = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").slice(offset) : "";
  const rows = appended.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.event === "auth_failure");
  return { status: response.status, rows, appended };
}

const mcpBody = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) };

test("a bad Bearer on /mcp writes one auth_failure line with the path and no token material", async () => {
  const result = await probe("/mcp?access_token=unused", { ...mcpBody, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  expect(result.status).toBe(401);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ event: "auth_failure", result: "deny", scope: "/mcp" });
  expect(typeof result.rows[0]!.ip).toBe("string");
  expect(result.appended).not.toContain(token.slice(2, 14));
  expect(result.appended).not.toContain("unused");
});

test("a bad Bearer or a junk dashboard cookie on /api/dashboard/* is audited", async () => {
  const bearer = await probe("/api/dashboard/agents", { headers: { authorization: `Bearer ${token}` } });
  expect(bearer.status).toBe(401);
  expect(bearer.rows.map((row) => row.scope)).toEqual(["/api/dashboard/agents"]);
  const cookie = await probe("/api/dashboard/agents", { headers: { cookie: "qoopia_dash=junk.value" } });
  expect(cookie.status).toBe(401);
  expect(cookie.rows.map((row) => row.scope)).toEqual(["/api/dashboard/agents"]);
});

test("an anonymous 401 (MCP OAuth discovery) writes nothing", async () => {
  const result = await probe("/mcp", { ...mcpBody, headers: { "content-type": "application/json" } });
  expect(result.status).toBe(401);
  expect(result.rows).toHaveLength(0);
});

test("/oauth/* keeps its own audit record and is not logged twice", async () => {
  const result = await probe("/oauth/register", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ client_name: "x", redirect_uris: ["https://example.com/cb"] }),
  });
  expect(result.status).toBe(401);
  expect(result.rows).toHaveLength(1);
});
