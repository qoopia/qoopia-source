/**
 * F-181: the dashboard Origin allowlist follows the same proxy-trust rule as isHttps and
 * getClientIp. X-Forwarded-Host/Proto count only from a trusted proxy peer with
 * TRUST_PROXY on, and the request's own Host is allowed only with the scheme in use.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { originAllowed } from "../src/dashboard-session.ts";
import { env } from "../src/utils/env.ts";

const trustProxy = env.TRUST_PROXY;
afterEach(() => { env.TRUST_PROXY = trustProxy; });

const request = (headers: Record<string, string>, socket: { remoteAddress: string; encrypted?: boolean }) =>
  ({ headers, socket } as unknown as IncomingMessage);

describe("F-181: dashboard origin allowlist", () => {
  test("forwarded headers from an untrusted peer add nothing", () => {
    env.TRUST_PROXY = false;
    const forged = { host: "memory.example", origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" };
    expect(originAllowed(request(forged, { remoteAddress: "127.0.0.1" }))).toBe(false);
    env.TRUST_PROXY = true;
    expect(originAllowed(request(forged, { remoteAddress: "203.0.113.9" }))).toBe(false);
  });

  test("a trusted proxy's forwarded public host is allowed", () => {
    env.TRUST_PROXY = true;
    const proxied = { host: "qoopia-corsair:3738", origin: "https://mcp.example", "x-forwarded-host": "mcp.example", "x-forwarded-proto": "https" };
    expect(originAllowed(request(proxied, { remoteAddress: "127.0.0.1" }))).toBe(true);
  });

  test("the request's own Host is allowed only with the scheme in use", () => {
    env.TRUST_PROXY = false;
    const tls = { remoteAddress: "198.51.100.4", encrypted: true };
    expect(originAllowed(request({ host: "memory.example", origin: "http://memory.example" }, tls))).toBe(false);
    expect(originAllowed(request({ host: "memory.example", origin: "https://memory.example" }, tls))).toBe(true);
    const plain = { remoteAddress: "127.0.0.1" };
    expect(originAllowed(request({ host: "127.0.0.1:3737", origin: "http://127.0.0.1:3737" }, plain))).toBe(true);
    expect(originAllowed(request({ host: "127.0.0.1:3737", origin: "https://127.0.0.1:3737" }, plain))).toBe(false);
  });
});
