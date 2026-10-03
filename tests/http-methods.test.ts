/**
 * HTTP method handling (F-151, F-156, F-158): read routes answer HEAD like GET and refuse other
 * methods with 405 + Allow; OAuth's state-changing GETs stay GET-only; public paths match exactly.
 * Bun writes HEAD bodies onto the wire, so the server drops them itself.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import net, { type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server, base = "", STEW = "";
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Http Methods", slug: "http-methods" });
  STEW = createAgent({ name: "methods-s", workspaceSlug: ws.slug, type: "steward" }).api_key;
  server = startHttpServer();
  if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); });

const call = (path: string, method: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers, redirect: "manual" });

test("read routes answer HEAD like GET", async () => {
  const steward = { authorization: `Bearer ${STEW}` };
  for (const [path, headers] of [["/health", {}], ["/ready", {}], ["/", {}], ["/dashboard", {}], ["/.well-known/oauth-authorization-server", {}],
    ["/.well-known/oauth-protected-resource/mcp", {}], ["/api/v1/capabilities", {}], ["/api/dashboard/agents", steward]] as const) {
    const get = await call(path, "GET", headers), head = await call(path, "HEAD", headers);
    expect([path, head.status]).toEqual([path, get.status]);
    expect(await head.text()).toBe("");
  }
  // No body bytes on the wire: a pipelined request after HEAD still gets its own response.
  const wire = await new Promise<string>((resolve) => {
    const s = net.connect(Number(new URL(base).port), "127.0.0.1", () =>
      s.write("HEAD /ready HTTP/1.1\r\nHost: x\r\n\r\nGET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let got = ""; s.on("data", (d) => (got += d)); s.on("close", () => resolve(got));
  });
  expect(wire.split("\r\n").filter((l) => l.startsWith("HTTP/1.1"))).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 404 Not Found"]);
});

test("other methods on read routes get 405 with an Allow header", async () => {
  for (const [path, method, allow] of [["/health", "DELETE", "GET, HEAD"], ["/ready", "POST", "GET, HEAD"], ["/", "PUT", "GET, HEAD"],
    ["/dashboard", "DELETE", "GET, HEAD"], ["/.well-known/oauth-protected-resource", "DELETE", "GET, HEAD"],
    ["/.well-known/oauth-authorization-server", "PUT", "GET, HEAD"], ["/oauth/revoke", "GET", "POST"], ["/oauth/token", "GET", "POST"],
    ["/oauth/register", "GET", "POST"], ["/ingest/session", "GET", "POST"], ["/memory/continuity", "GET", "POST"],
    ["/ingest/allowlist", "POST", "GET"], ["/oauth/authorize", "POST", "GET"]] as const) {
    const r = await call(path, method);
    expect([path, method, r.status, r.headers.get("allow")]).toEqual([path, method, 405, allow]);
  }
  const dash = await call("/api/dashboard/agents", "DELETE", { authorization: `Bearer ${STEW}` });
  expect([dash.status, dash.headers.get("allow")]).toEqual([405, "GET, HEAD"]);
});

test("OAuth's state-changing GETs refuse HEAD, and public prefixes are exact", async () => {
  for (const path of ["/oauth/authorize?client_id=x", "/oauth/authorize/finalize?ticket=qct_x"]) {
    const r = await call(path, "HEAD");
    expect([path, r.status, r.headers.get("allow")]).toEqual([path, 405, "GET"]);
  }
  for (const path of ["/oauth/authorizeX", "/oauth/authorize/anything", "/.well-known/oauth-protected-resourceXYZ"])
    expect([path, (await call(path, "GET")).status]).toEqual([path, 404]);
});
