/**
 * F-126: anonymous callers must not be able to lock the owner out of hosted sign-in.
 *  - /start no longer refuses once 20 sign-ins are pending anywhere: one client keeps
 *    at most its two newest, and a full table drops the oldest, so a start always runs.
 *  - Every /api/dashboard route shares the per-IP dashboard limit exactly once, and
 *    /identity/start alone also takes the strict auth limit (polling stays exempt).
 * A4: the sign-in service counts starts per visitor network behind the installation that relays
 *    them, and an installation spends a bounded share of that service's requests on polling.
 * A10: an IPv6 client is counted by its /64, so choosing another address of its own network
 *    is no way around a per-client limit.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { localIdentityLogin, LOGIN_ORIGIN } from "../src/identity/local.ts";
import { loginBroker } from "../src/identity/broker.ts";
import { env } from "../src/utils/env.ts";
import { durableWrite, privateDirectory } from "../src/utils/fs.ts";
import { startHttpServer } from "../src/http.ts";
import { authLimiter, dashboardLimiter, globalLimiter, limitKey, RateLimiter } from "../src/utils/rate-limit.ts";

let root = "";
let OWNER_ID = "";
const brokerRequests: string[] = [];
const brokerBodies: Record<string, unknown>[] = [];
const stubBroker = (async (input: string | URL | Request, init?: RequestInit) => {
  const route = new URL(String(input)).pathname;
  brokerRequests.push(route);
  brokerBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  if (route === "/requests") return Response.json({ id: crypto.randomUUID().replaceAll("-", "").padEnd(43, "x"), confirm_code: "123456" }, { status: 201 });
  if (route === "/redeem") return Response.json({ pending: true }, { status: 202 });
  throw new Error(`unexpected broker call ${route} ${String(init?.body)}`);
}) as typeof fetch;

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Lockout", slug: "f126-lockout" });
  OWNER_ID = bootstrapOwner(db, "F126 owner", undefined, ws.id).agent_id;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-f126-"));
  privateDirectory(path.join(root, "config"));
  durableWrite(path.join(root, "config/owner-identity.json"), JSON.stringify({ ownerId: OWNER_ID, email: "owner@example.com" }));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function client(login: ReturnType<typeof localIdentityLogin>, ip: string, encrypted = false) {
  let pending = "";
  return async (route: string, body: Record<string, unknown> = {}) => {
    let status = 0, payload = "";
    const res = {
      setHeader: (name: string, value: string) => { if (name === "set-cookie") pending = value.split(";")[0]!; },
      writeHead: (code: number) => { status = code; },
      end: (value: string) => { payload = value; },
    } as unknown as ServerResponse;
    await login({ method: "POST", headers: { cookie: pending }, socket: { remoteAddress: ip, encrypted } } as unknown as IncomingMessage, res, route, body);
    return { status, data: JSON.parse(payload) as Record<string, unknown> };
  };
}

describe("F-126: pending sign-ins cannot be filled by anonymous callers", () => {
  test("25 anonymous starts do not refuse the owner, and one client cannot evict the owner's pending sign-in", async () => {
    const login = localIdentityLogin(root, db, stubBroker);
    for (let i = 0; i < 25; i++) expect((await client(login, `10.0.0.${i}`)("/start", { method: "google" })).status).toBe(200);
    const owner = client(login, "192.0.2.1");
    expect((await owner("/start", { method: "google" })).status).toBe(200);
    const attacker = client(login, "10.9.9.9");
    for (let i = 0; i < 30; i++) expect((await attacker("/start", { method: "google" })).status).toBe(200);
    expect(await owner("/poll")).toEqual({ status: 200, data: { pending: true } });
  });

  test("an e-mail start for another address never reaches the broker and looks like the owner's (A3-04)", async () => {
    const login = localIdentityLogin(root, db, stubBroker);
    const before = brokerRequests.length;
    const stranger = client(login, "10.1.1.1");
    const decoy = await stranger("/start", { method: "email", email: "victim@example.org" });
    expect(brokerRequests.length).toBe(before);
    const owner = client(login, "10.1.1.2");
    const real = await owner("/start", { method: "email", email: "Owner@example.com" });
    expect(brokerRequests.length).toBe(before + 1);
    expect([decoy.status, Object.keys(decoy.data)]).toEqual([real.status, Object.keys(real.data)]);
    expect(await stranger("/poll")).toEqual({ status: 200, data: { pending: true } });
  });

  test("a start reports the visitor's address for every method, so the sign-in service can count it per visitor (A4)", async () => {
    const login = localIdentityLogin(root, db, stubBroker);
    const previous = env.PUBLIC_URL;
    env.PUBLIC_URL = "https://hosted.example";
    try {
      expect((await client(login, "198.51.100.7", true)("/start", { method: "account" })).status).toBe(200);
      expect(brokerBodies.at(-1)).toMatchObject({ method: "account", starter_ip: "198.51.100.7" });
      expect(brokerBodies.at(-1)).not.toHaveProperty("bind");
      expect((await client(login, "198.51.100.8")("/start", { method: "google" })).status).toBe(200);
      expect(brokerBodies.at(-1)).toMatchObject({ method: "google", starter_ip: "198.51.100.8", bind: "network" });
    } finally { env.PUBLIC_URL = previous; }
  });

  test("polling asks the sign-in service a bounded number of times a minute, shared by all pending sign-ins (A4)", async () => {
    const redeems = () => brokerRequests.filter((route) => route === "/redeem").length;
    const clock = spyOn(Date, "now").mockReturnValue(Math.floor(Date.now() / 60_000) * 60_000 + 1000);
    try {
      const login = localIdentityLogin(root, db, stubBroker);
      const visitor = client(login, "198.51.100.9");
      await visitor("/start", { method: "google" });
      let before = redeems();
      for (let i = 0; i < 40; i++) expect(await visitor("/poll")).toEqual({ status: 200, data: { pending: true } });
      expect(redeems() - before).toBe(30);
      // Twenty pending sign-ins (the table's limit) together stay under the service's 300 requests a minute.
      const crowded = localIdentityLogin(root, db, stubBroker);
      const visitors = Array.from({ length: 20 }, (_, i) => client(crowded, `198.51.100.${20 + i}`));
      for (const start of visitors) await start("/start", { method: "google" });
      before = redeems();
      for (const poll of visitors) for (let i = 0; i < 40; i++) await poll("/poll");
      expect(redeems() - before).toBe(240);
    } finally { clock.mockRestore(); }
  });
});

describe("A4: the sign-in service counts starts per visitor behind an installation", () => {
  const broker = () => loginBroker(new Database(":memory:"), { origin: LOGIN_ORIGIN, resendKey: "fixture", from: "Qoopia <login@mail.qoopia.ai>", googleClientId: "fixture-client", googleClientSecret: "fixture-secret" });
  const starter = (handler: ReturnType<typeof broker>) => async (server: string, starter_ip?: string) => {
    const response = await handler(new Request(LOGIN_ORIGIN + "/requests", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "google", bind: "network", challenge: "a".repeat(64), ...(starter_ip ? { starter_ip } : {}) }) }), server);
    return [response.status, ((await response.json()) as { error?: string }).error ?? ""];
  };
  const refused = [429, "Too many sign-in attempts. Please try again later"];

  test("twenty starts by one visitor of a hosted dashboard do not lock its owner out", async () => {
    const start = starter(broker());
    for (let i = 0; i < 20; i++) expect((await start("203.0.113.7", "198.51.100.1"))[0]).toBe(201);
    expect(await start("203.0.113.7", "198.51.100.1")).toEqual(refused);
    expect((await start("203.0.113.7", "192.0.2.1"))[0]).toBe(201);
    // Someone calling the service directly cannot spend that visitor's starts through the installation either.
    for (let i = 0; i < 20; i++) expect((await start("203.0.113.66", "192.0.2.1"))[0]).toBe(201);
    expect((await start("203.0.113.7", "192.0.2.1"))[0]).toBe(201);
    // A caller that reports nothing, or a private address, is counted by its own address as before.
    for (let i = 0; i < 20; i++) expect((await start("203.0.113.9", i % 2 ? "10.0.0.5" : undefined))[0]).toBe(201);
    expect(await start("203.0.113.9")).toEqual(refused);
  });

  test("a caller that reports a new address each time stops at the per-server ceiling", async () => {
    const start = starter(broker());
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const clock = spyOn(Date, "now");
    try {
      // Two minutes of one hour: the service also allows one address 300 requests a minute.
      for (let i = 0; i < 300; i++) {
        clock.mockReturnValue(hour + (i < 200 ? 1000 : 61_000));
        expect((await start("203.0.113.8", `198.51.${100 + Math.floor(i / 250)}.${i % 250}`))[0]).toBe(201);
      }
      expect(await start("203.0.113.8", "198.51.102.1")).toEqual(refused);
    } finally { clock.mockRestore(); }
  });
});

describe("F-126: dashboard rate limits", () => {
  let server: Server;
  let baseUrl = "";
  const reset = () => { for (const limiter of [globalLimiter, dashboardLimiter, authLimiter]) limiter.resetForTests(); };
  const previous = process.env.QOOPIA_OWNER_LOGIN;
  beforeAll(async () => {
    server = startHttpServer();
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    reset();
    if (previous === undefined) delete process.env.QOOPIA_OWNER_LOGIN; else process.env.QOOPIA_OWNER_LOGIN = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const statuses = async (count: number, path: string, init: RequestInit = {}) => {
    const seen: number[] = [];
    for (let i = 0; i < count; i++) seen.push((await fetch(`${baseUrl}${path}`, init)).status);
    return seen;
  };

  test("an early-dispatched route (/profile) is limited after 200 requests a minute", async () => {
    reset();
    const seen = await statuses(201, "/api/dashboard/profile");
    expect(seen.slice(0, 200).every((status) => status === 401)).toBe(true);
    expect(seen[200]).toBe(429);
  });

  test("a route that used to call the limiter itself is counted once", async () => {
    reset();
    expect((await statuses(150, "/api/dashboard/files", { method: "POST" })).every((status) => status === 401)).toBe(true);
  });

  test("/identity/start takes the strict per-IP limit; /identity/poll does not", async () => {
    reset();
    process.env.QOOPIA_OWNER_LOGIN = "true";
    const starts = await statuses(21, "/api/dashboard/identity/start", { method: "POST" });
    expect(starts.slice(0, 20).includes(429)).toBe(false);
    expect(starts[20]).toBe(429);
    expect((await statuses(30, "/api/dashboard/identity/poll", { method: "POST" })).includes(429)).toBe(false);
  });
});

describe("A10: per-client limits count an IPv6 client by its /64", () => {
  test("addresses of one /64 share a key; another /64, IPv4 and labels keep their own", () => {
    expect(limitKey("2001:db8:abcd:12::1")).toBe(limitKey("2001:0db8:abcd:0012:9999:8888:7777:6666"));
    expect(limitKey("2001:db8:abcd:12::1")).not.toBe(limitKey("2001:db8:abcd:13::1"));
    expect(limitKey("edge:2001:db8:abcd:12::1")).toBe("edge:" + limitKey("2001:db8:abcd:12::9"));
    // An IPv4 client on a dual-stack socket is still one address, not the whole mapped range.
    for (const same of ["203.0.113.7", "::ffff:203.0.113.7", "edge:203.0.113.7", "edge:unknown", "unknown", "test-device"]) expect(limitKey(same)).toBe(same);
  });

  test("the server's limiters refuse the next address of a /64 that spent its allowance", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxHits: 20 });
    for (let i = 0; i < 20; i++) expect(limiter.allow(`2001:db8:abcd:12::${i.toString(16)}`)).toBe(true);
    expect(limiter.allow("2001:db8:abcd:12:ffff::1")).toBe(false);
    expect(limiter.retryAfterSec("2001:db8:abcd:12:ffff::2")).toBeGreaterThan(0);
    expect(limiter.allow("2001:db8:abcd:13::1")).toBe(true);
  });

  test("the sign-in service counts starts and requests the same way", async () => {
    const handler = loginBroker(new Database(":memory:"), { origin: LOGIN_ORIGIN, resendKey: "fixture", from: "Qoopia <login@mail.qoopia.ai>", googleClientId: "fixture-client", googleClientSecret: "fixture-secret" });
    const start = async (ip: string) => (await handler(new Request(LOGIN_ORIGIN + "/requests", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "google", bind: "network", challenge: "a".repeat(64) }) }), ip)).status;
    for (let i = 0; i < 20; i++) expect(await start(`2001:db8:abcd:12::${i.toString(16)}`)).toBe(201);
    expect(await start("2001:db8:abcd:12:ffff::1")).toBe(429);
    expect(await start("2001:db8:abcd:13::1")).toBe(201);
    // 300 requests a minute for one client, whichever of its addresses each arrives from.
    let refused = 0;
    for (let i = 0; i < 300; i++) if ((await handler(new Request(LOGIN_ORIGIN + "/health"), `2001:db8:abcd:14::${i.toString(16)}`)).status === 429) refused++;
    expect(refused).toBe(0);
    expect((await handler(new Request(LOGIN_ORIGIN + "/health"), "2001:db8:abcd:14:ffff::1")).status).toBe(429);
  });
});
