/**
 * Request bodies and idle connections are bounded in our own code (F-084, F-086): Bun's
 * node:http ignores requestTimeout/headersTimeout/keepAliveTimeout, and a reader that
 * destroys the socket or breaks out of for-await loses the 413 it meant to send.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { REQUEST_TIMEOUTS } from "../src/utils/http-json.ts";

let server: Server, base = "", port = 0, KEY = "", STEW = "", AGENT_ID = "";
const saved = { ...REQUEST_TIMEOUTS };

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Body Limits", slug: "body-limits" });
  const agent = createAgent({ name: "body-a", workspaceSlug: ws.slug });
  KEY = agent.api_key; AGENT_ID = agent.id;
  STEW = createAgent({ name: "body-s", workspaceSlug: ws.slug, type: "steward" }).api_key;
  server = startHttpServer();
  if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port; base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  Object.assign(REQUEST_TIMEOUTS, saved);
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Write raw bytes, then report the first response line and whether/when the server closed the socket. */
function raw(head: string, opts: { drip?: string; waitMs?: number } = {}) {
  return new Promise<{ line: string; closedMs: number | null; text: string }>((resolve) => {
    const s = net.connect(port, "127.0.0.1"); const t0 = Date.now(); let got = ""; let timer: ReturnType<typeof setInterval> | undefined;
    s.on("connect", () => { s.write(head); if (opts.drip) timer = setInterval(() => { if (!s.destroyed) s.write(opts.drip!); }, 20); });
    s.on("data", (d) => (got += d));
    const done = (closed: boolean) => { clearInterval(timer); s.destroy(); resolve({ line: got.split("\r\n")[0]!, closedMs: closed ? Date.now() - t0 : null, text: got }); };
    s.on("close", () => done(true)); s.on("error", () => done(true));
    setTimeout(() => done(false), opts.waitMs ?? 3000);
  });
}

test("an over-limit body gets a 413 JSON reply, not a reset or an empty 200", async () => {
  const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${KEY}` }, body: "a".repeat(1_048_577) });
  expect(mcp.status).toBe(413);
  expect(await mcp.json()).toEqual({ error: "payload_too_large", max_bytes: 1_048_576 });
  const policy = await fetch(`${base}/api/dashboard/agents/${AGENT_ID}/memory-policy`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${STEW}`, "x-qoopia-csrf": "1" },
    body: JSON.stringify({ mode: "manual", pad: "a".repeat(70_000) }) });
  expect(policy.status).toBe(413);
  expect(await policy.json()).toEqual({ error: "payload_too_large" });
});

test("a declared Content-Length over the limit is refused before the body arrives, then the socket closes", async () => {
  const upload = await raw(`POST /api/dashboard/files HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${STEW}\r\nContent-Type: multipart/form-data; boundary=b\r\nContent-Length: 104857601\r\n\r\n--b`);
  expect(upload.line).toBe("HTTP/1.1 413 Payload Too Large");
  expect(upload.closedMs).not.toBeNull();
  const token = await raw("POST /oauth/token HTTP/1.1\r\nHost: x\r\nContent-Length: 2000000\r\n\r\nx");
  expect(token.line).toBe("HTTP/1.1 413 Payload Too Large");
  expect(token.closedMs).not.toBeNull();
});

test("an endless chunked body is cut off after the 413", async () => {
  const chunk = "a".repeat(16_384);
  const r = await raw("POST /oauth/token HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n", { drip: `${chunk.length.toString(16)}\r\n${chunk}\r\n`, waitMs: 8000 });
  expect(r.line).toBe("HTTP/1.1 413 Payload Too Large");
  expect(r.closedMs).not.toBeNull();
});

test("an anonymous request is refused from its headers, without waiting for the body (F-087)", async () => {
  for (const [path, size, status] of [["/api/v1/skills/captures", 4_000_000, 401], ["/mcp", 1_000_000, 401], ["/ingest/session", 1_000_000, 403]] as const) {
    const r = await raw(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${size}\r\n\r\n{`, { waitMs: 1000 });
    expect([path, r.line.split(" ")[1]]).toEqual([path, String(status)]);
    expect(r.closedMs).not.toBeNull();
  }
});

test("a repeated Content-Length, Authorization or Host is refused and nothing after it is served (F-153)", async () => {
  const smuggle = await raw("POST /oauth/token HTTP/1.1\r\nHost: x\r\nContent-Length: 41\r\nContent-Length: 5\r\n\r\nhelloGET /health HTTP/1.1\r\nHost: x\r\n\r\n");
  expect(smuggle.text.split("\r\n").filter((l) => l.startsWith("HTTP/1.1"))).toEqual(["HTTP/1.1 400 Bad Request"]);
  expect(smuggle.closedMs).not.toBeNull();
  const auth = await raw(`GET /api/dashboard/agents HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer bogus\r\nAuthorization: Bearer ${STEW}\r\n\r\n`);
  expect(auth.line).toBe("HTTP/1.1 400 Bad Request");
  const host = await raw("GET /health HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n");
  expect(host.line).toBe("HTTP/1.1 400 Bad Request");
  expect(host.text).toContain('{"error":"duplicate_header"}');
});

test("a body at the limit is read, not refused", async () => {
  const r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a".repeat(1_048_576) });
  expect(r.status).not.toBe(413);
});

test("a stalled body gets a 408 within the body deadline and the socket closes", async () => {
  REQUEST_TIMEOUTS.bodyBaseMs = 300;
  try {
    const r = await raw("POST /oauth/token HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nab");
    expect(r.line).toBe("HTTP/1.1 408 Request Timeout");
    expect(r.closedMs).not.toBeNull();
    expect(r.closedMs!).toBeLessThan(2000);
    // The upload route keeps its own 413 text but does not report a stall as "too large".
    const upload = await raw(`POST /api/dashboard/files HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${STEW}\r\nContent-Type: multipart/form-data; boundary=b\r\nContent-Length: 1000\r\n\r\n--b`);
    expect(upload.line).toBe("HTTP/1.1 408 Request Timeout");
  } finally { REQUEST_TIMEOUTS.bodyBaseMs = saved.bodyBaseMs; }
});

test("an idle keep-alive socket is closed, an active one is not", async () => {
  REQUEST_TIMEOUTS.keepAliveIdleMs = 400;
  try {
    const idle = await raw("GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(idle.line).toBe("HTTP/1.1 200 OK");
    expect(idle.closedMs).not.toBeNull();
    // Requests every 200 ms on one socket keep it open past the idle limit.
    const active = await new Promise<{ responses: number; serverClosed: boolean }>((resolve) => {
      const s = net.connect(port, "127.0.0.1"); let got = ""; let serverClosed = false;
      const send = () => { if (!s.destroyed) s.write("GET /health HTTP/1.1\r\nHost: x\r\n\r\n"); };
      s.on("connect", send); s.on("data", (d) => (got += d)); s.on("close", () => (serverClosed = true));
      const timer = setInterval(send, 200);
      setTimeout(() => { clearInterval(timer); const closed = serverClosed; s.destroy(); resolve({ responses: (got.match(/HTTP\/1.1 200/g) || []).length, serverClosed: closed }); }, 1500);
    });
    expect(active.serverClosed).toBe(false);
    expect(active.responses).toBeGreaterThanOrEqual(6);
  } finally { REQUEST_TIMEOUTS.keepAliveIdleMs = saved.keepAliveIdleMs; }
});
