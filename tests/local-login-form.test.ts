/**
 * F-182: the owner-code form on the dashboard is a native POST when it is submitted before
 * dashboard.js attaches (or without JS). Under the page's old `no-referrer` policy that
 * POST carried `Origin: null` and local-login always refused it. The dashboard page now uses
 * `same-origin` (no Referer still leaves the origin), and a form submission that signs in is
 * answered with 303 to /dashboard instead of raw JSON. The JSON fetch contract is unchanged.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { issueLocalLogin } from "../src/delivery/local-login.ts";
import { startHttpServer } from "../src/http.ts";
import { env } from "../src/utils/env.ts";

let server: Server;
let base = "";
let OWNER_ID = "";
const previous = { port: env.PORT, standalone: process.env.QOOPIA_STANDALONE };

beforeAll(async () => {
  runMigrations();
  const ws = randomUUID();
  db.query("INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)").run(ws, "Local login form", ws);
  OWNER_ID = bootstrapOwner(db, "Form owner", undefined, ws).agent_id;
  process.env.QOOPIA_STANDALONE = "true";
  env.PORT = 0;
  server = startHttpServer();
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  env.PORT = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${env.PORT}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  env.PORT = previous.port;
  if (previous.standalone === undefined) delete process.env.QOOPIA_STANDALONE; else process.env.QOOPIA_STANDALONE = previous.standalone;
});

test("the dashboard page keeps its origin on same-origin requests", async () => {
  expect((await fetch(`${base}/dashboard`)).headers.get("referrer-policy")).toBe("same-origin");
  expect((await fetch(`${base}/local-login`)).headers.get("referrer-policy")).toBe("same-origin");
});

test("a native form sign-in lands on the dashboard with the session cookie", async () => {
  const r = await fetch(`${base}/api/dashboard/local-login`, {
    method: "POST", redirect: "manual",
    headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: issueLocalLogin(OWNER_ID) }),
  });
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/dashboard");
  expect(r.headers.get("set-cookie")).toContain("qoopia_dash=");
});

test("the JSON sign-in the dashboard script sends is unchanged", async () => {
  const r = await fetch(`${base}/api/dashboard/local-login`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ code: issueLocalLogin(OWNER_ID) }),
  });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
});
