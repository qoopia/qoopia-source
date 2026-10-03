/**
 * F-126: anonymous callers must not be able to lock the owner out of hosted sign-in.
 *  - /start no longer refuses once 20 sign-ins are pending anywhere: one client keeps
 *    at most its two newest, and a full table drops the oldest, so a start always runs.
 *  - Every /api/dashboard route shares the per-IP dashboard limit exactly once, and
 *    /identity/start alone also takes the strict auth limit (polling stays exempt).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { localIdentityLogin } from "../src/identity/local.ts";
import { durableWrite, privateDirectory } from "../src/utils/fs.ts";
import { startHttpServer } from "../src/http.ts";
import { authLimiter, dashboardLimiter, globalLimiter } from "../src/utils/rate-limit.ts";

let root = "";
let OWNER_ID = "";
const brokerRequests: string[] = [];
const stubBroker = (async (input: string | URL | Request, init?: RequestInit) => {
  const route = new URL(String(input)).pathname;
  brokerRequests.push(route);
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

function client(login: ReturnType<typeof localIdentityLogin>, ip: string) {
  let pending = "";
  return async (route: string, body: Record<string, unknown> = {}) => {
    let status = 0, payload = "";
    const res = {
      setHeader: (name: string, value: string) => { if (name === "set-cookie") pending = value.split(";")[0]!; },
      writeHead: (code: number) => { status = code; },
      end: (value: string) => { payload = value; },
    } as unknown as ServerResponse;
    await login({ method: "POST", headers: { cookie: pending }, socket: { remoteAddress: ip } } as unknown as IncomingMessage, res, route, body);
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

  test("an e-mail start for an address other than the linked one is refused before the broker", async () => {
    const login = localIdentityLogin(root, db, stubBroker);
    const before = brokerRequests.length;
    const refused = await client(login, "10.1.1.1")("/start", { method: "email", email: "victim@example.org" });
    expect(refused.status).toBe(400);
    expect(brokerRequests.length).toBe(before);
    expect((await client(login, "10.1.1.1")("/start", { method: "email", email: "Owner@example.com" })).status).toBe(200);
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
