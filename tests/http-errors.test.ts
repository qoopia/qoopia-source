/**
 * Errors caused by client input keep a 4xx status at the central HTTP catch (F-085): an unknown
 * connection id is 404 and malformed %-encoding is 400, without an ERROR log line. A real fault
 * is logged with method and pathname (F-154).
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import net, { type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { logger } from "../src/utils/logger.ts";
import * as healthMetadata from "../src/utils/health-metadata.ts";
import { env } from "../src/utils/env.ts";

let server: Server, base = "", STEW = "", AGENT_ID = "";
const errorLog = spyOn(logger, "error");

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Http Errors", slug: "http-errors" });
  STEW = createAgent({ name: "errors-s", workspaceSlug: ws.slug, type: "steward" }).api_key;
  AGENT_ID = createAgent({ name: "errors-a", workspaceSlug: ws.slug }).id;
  server = startHttpServer();
  if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { errorLog.mockRestore(); server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => errorLog.mockClear());
const handlerFailures = () => errorLog.mock.calls.filter((c) => c[0] === "Request handler failed").length;

test("an unknown connection id is 404 on discovery and connection-scoped MCP, and 400 on DCR", async () => {
  const id = "00000000-0000-0000-0000-000000000000";
  for (const [path, method, status] of [
    [`/.well-known/oauth-authorization-server/oauth/c/${id}`, "GET", 404],
    [`/.well-known/oauth-protected-resource/mcp/c/${id}`, "GET", 404],
    [`/mcp/c/${id}`, "POST", 404],
    [`/oauth/register?connection=${id}`, "POST", 400],
    ["/oauth/register?connection=%ZZ", "POST", 400],
  ] as const) {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: method === "POST" ? "{}" : undefined });
    expect([path, r.status]).toEqual([path, status]);
  }
  expect(handlerFailures()).toBe(0);
});

test("malformed %-encoding in a path parameter is 400, including before auth", async () => {
  const auth = { authorization: `Bearer ${STEW}` };
  const cases: Array<[string, string, Record<string, string>]> = [
    ["/api/dashboard/files/%ZZ", "DELETE", {}],
    ["/api/dashboard/files/%ZZ/download", "GET", auth],
    ["/api/dashboard/agents/%ZZ/contract", "GET", auth],
    ["/api/dashboard/agents/%ZZ/sessions", "GET", auth],
    ["/api/dashboard/sessions/%ZZ/messages", "GET", auth],
    ["/api/v1/skills/%ZZ", "GET", auth],
  ];
  for (const [path, method, headers] of cases) {
    const r = await fetch(base + path, { method, headers });
    expect([path, r.status]).toEqual([path, 400]);
  }
  const v1 = await (await fetch(`${base}/api/v1/skills/%E0%A4%A`, { headers: auth })).json() as { error: { code: string } };
  expect(v1.error.code).toBe("INVALID_INPUT");
  expect(handlerFailures()).toBe(0);
});

test("a client that disconnects mid-body is logged at info with method and path, not as a failure (F-154)", async () => {
  const info = spyOn(logger, "info");
  try {
    const s = net.connect(Number(new URL(base).port), "127.0.0.1", () => s.write("POST /oauth/token?code=secret HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nabc"));
    await Bun.sleep(150); s.destroy(); await Bun.sleep(300);
    expect(handlerFailures()).toBe(0);
    expect(info.mock.calls.some((c) => c[0] === "Client closed the request" && JSON.stringify(c[1]) === '{"method":"POST","path":"/oauth/token"}')).toBe(true);
  } finally { info.mockRestore(); }
});

test("a server fault logs method and pathname only, and its 500 carries CORS headers (F-154)", async () => {
  const flags = spyOn(healthMetadata, "getV4FeatureFlags").mockImplementation(() => { throw new Error("boom"); });
  try {
    const r = await fetch(`${base}/health?token=secret`, { headers: { origin: "https://claude.ai" } });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "internal_error" });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    const failures = errorLog.mock.calls.filter((c) => c[0] === "Request handler failed");
    expect(failures).toEqual([["Request handler failed", { method: "GET", path: "/health", error: "Error: boom" }]]);
  } finally { flags.mockRestore(); }
});

/** Status of a raw request-target that fetch() would normalise away. */
function rawStatus(target: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(Number(new URL(base).port), "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let got = ""; s.on("data", (d) => (got += d)); s.on("close", () => resolve(got.split("\r\n")[0]!.split(" ")[1] ?? "none"));
    s.on("error", () => resolve("error"));
  });
}

test("a protocol-relative request-target is routed by its own path, not as another route (F-150)", async () => {
  for (const [target, status] of [["//evil.example/health", "404"], ["/\\evil.example/health", "404"], ["//", "404"],
    ["//x/oauth/consent", "404"], ["/health", "200"], ["/dashboard?next=/x", "200"], ["http://evil.example/health", "200"]] as const)
    expect([target, await rawStatus(target)]).toEqual([target, status]);
  expect(handlerFailures()).toBe(0);
});

test("a write refused by a read-only instance is 503 read_only_instance on /api/v1 too (F-155)", async () => {
  const role = env.SERVER_ROLE;
  (env as { SERVER_ROLE: string }).SERVER_ROLE = "legacy-readonly";
  try {
    const r = await fetch(`${base}/api/v1/skills/drafts`, { method: "POST", body: JSON.stringify({ slug: "ro-skill", content: { title: "x" } }),
      headers: { authorization: `Bearer ${STEW}`, "content-type": "application/json", "idempotency-key": "ro", "if-match": "0" } });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: { code: "READ_ONLY_INSTANCE" } });
  } finally { (env as { SERVER_ROLE: string }).SERVER_ROLE = role; }
  expect(handlerFailures()).toBe(0);
});

test("MCP malformed JSON gets the JSON-RPC parse-error shape like every other MCP error (F-152)", async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST", body: "{bad",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${STEW}` } });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null });
});

test("malformed or non-object JSON on the dashboard memory POSTs is 400 invalid_input (F-149)", async () => {
  const headers = { "content-type": "application/json", authorization: `Bearer ${STEW}`, "x-qoopia-csrf": "1" };
  for (const path of [`/api/dashboard/agents/${AGENT_ID}/memory-policy`, "/api/dashboard/memory-saves/msr_x"]) {
    for (const body of ["{bad", "null", "[]", "1"]) {
      const r = await fetch(base + path, { method: "POST", headers, body });
      expect([path, body, r.status, (await r.json() as { error: unknown }).error]).toEqual([path, body, 400, "invalid_input"]);
    }
  }
});

test("DCR with a non-object body or a non-string client_name never echoes engine text (F-149)", async () => {
  const json = { "content-type": "application/json" };
  expect((await fetch(`${base}/oauth/register`, { method: "POST", headers: json, body: "null" })).status).toBe(401);
  const steward = { ...json, authorization: `Bearer ${STEW}` };
  const nul = await fetch(`${base}/oauth/register`, { method: "POST", headers: steward, body: "null" });
  expect(nul.status).toBe(400);
  expect(await nul.json()).toMatchObject({ error_description: "Body must be a JSON object" });
  const name = await fetch(`${base}/oauth/register`, { method: "POST", headers: steward,
    body: JSON.stringify({ client_name: { a: 1 }, redirect_uris: ["https://client.example/cb"] }) });
  expect(name.status).toBe(400);
  expect(await name.json()).toMatchObject({ error_description: "client_name must be a string" });
  expect(handlerFailures()).toBe(0);
});

test("an over-limit ingest message is a permanent 413, so the tailer skips it instead of retrying", async () => {
  const ingest = createAgent({ name: "errors-ingest", workspaceSlug: "http-errors", type: "ingest-daemon" }).api_key;
  const r = await fetch(base + "/ingest/session", { method: "POST",
    headers: { authorization: `Bearer ${ingest}`, "content-type": "application/json" },
    body: JSON.stringify({ attributed_agent_id: AGENT_ID, session_id: "s-oversize", uuid: "u-oversize", role: "user", content: "x".repeat(100_001) }) });
  expect(r.status).toBe(413);
  expect(handlerFailures()).toBe(0);
});
