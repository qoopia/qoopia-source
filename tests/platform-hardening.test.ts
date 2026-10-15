// Audit 5.0.21 A3-02/03/05/06: proxy trust ranges, owner session idle limit, public health, HSTS.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { startHttpServer } from "../src/http.ts";
import { env, isTrustedProxy } from "../src/utils/env.ts";
import { isHttps, SESSION_TTL_SEC, signSession, verifySession } from "../src/dashboard-session.ts";

let server: Server, base = "";
const saved = { trust: env.TRUST_PROXY, proxies: env.TRUSTED_PROXIES, login: process.env.QOOPIA_OWNER_LOGIN };
beforeAll(async () => {
  runMigrations();
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  env.TRUST_PROXY = saved.trust;
  env.TRUSTED_PROXIES = saved.proxies;
  if (saved.login === undefined) delete process.env.QOOPIA_OWNER_LOGIN; else process.env.QOOPIA_OWNER_LOGIN = saved.login;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("A3-02: TRUSTED_PROXIES accepts a CIDR range, so a docker-bridge tunnel counts as HTTPS", () => {
  const req = (remoteAddress: string) => ({ socket: { remoteAddress }, headers: { "x-forwarded-proto": "https" } }) as unknown as IncomingMessage;
  env.TRUST_PROXY = true;
  env.TRUSTED_PROXIES = ["127.0.0.1", "172.18.0.0/16"];
  try {
    expect(isTrustedProxy("172.18.0.3")).toBe(true);
    expect(isTrustedProxy("::ffff:172.18.0.3")).toBe(true);
    expect(isTrustedProxy("172.19.0.3")).toBe(false);
    expect(isTrustedProxy("127.0.0.1")).toBe(true);
    expect(isHttps(req("172.18.0.3"))).toBe(true);
    expect(isHttps(req("203.0.113.7"))).toBe(false);
    env.TRUST_PROXY = false;
    expect(isTrustedProxy("172.18.0.3")).toBe(false);
  } finally {
    env.TRUST_PROXY = saved.trust;
    env.TRUSTED_PROXIES = saved.proxies;
  }
});

test("A3-03: an owner session nobody used for the cookie's lifetime is refused by the server too", () => {
  process.env.QOOPIA_OWNER_LOGIN = "true";
  const fresh = signSession("owner-agent", 1, null);
  expect(verifySession(fresh)?.agent_id).toBe("owner-agent");
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() - (SESSION_TTL_SEC + 60) * 1000);
  let stale = "";
  try { stale = signSession("owner-agent", 1, null); } finally { clock.mockRestore(); }
  expect(verifySession(stale)).toBeNull();
  // A day-old one (renewed daily while in use) still works.
  const day = spyOn(Date, "now").mockReturnValue(Date.now() - 2 * 86400 * 1000);
  let used = "";
  try { used = signSession("owner-agent", 1, null); } finally { day.mockRestore(); }
  expect(verifySession(used)?.agent_id).toBe("owner-agent");
});

test("A3-05/06: public /health and /ready omit machine details; HTTPS answers of any type carry HSTS", async () => {
  env.TRUST_PROXY = true;
  env.TRUSTED_PROXIES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
  try {
    const local = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
    expect(local).toHaveProperty("instance_id");
    expect(local).toHaveProperty("uptime");
    for (const path of ["/health", "/ready"]) {
      const response = await fetch(`${base}${path}`, { headers: { "x-forwarded-proto": "https", "cf-connecting-ip": "203.0.113.9" } });
      const body = await response.json() as Record<string, unknown>;
      for (const key of ["instance_id", "uptime", "feature_flags", "embeddings", "protocol_kit_revision"]) expect([path, key, key in body]).toEqual([path, key, false]);
      for (const key of ["status", "version", "release_sha", "schema_version", "server_role"]) expect([path, key, key in body]).toEqual([path, key, true]);
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    }
    expect((await fetch(`${base}/`, { headers: { "x-forwarded-proto": "https" } })).headers.get("strict-transport-security")).toContain("max-age=");
    expect((await fetch(`${base}/health`)).headers.get("strict-transport-security")).toBeNull();
  } finally {
    env.TRUST_PROXY = saved.trust;
    env.TRUSTED_PROXIES = saved.proxies;
  }
});
