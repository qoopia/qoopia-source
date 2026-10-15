// Audit 5.0.21 A3d-07: anonymous pairing redemption is held to the login limit and audited.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { startHttpServer } from "../src/http.ts";
import { authLimiter } from "../src/utils/rate-limit.ts";
import { env } from "../src/utils/env.ts";

let server: Server, baseUrl = "";
beforeAll(async () => {
  runMigrations();
  authLimiter.resetForTests();
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  authLimiter.resetForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("guessing pairing codes hits the auth limit and every miss lands in the audit log", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 22; i++) {
    const response = await fetch(`${baseUrl}/api/v1/agent-pairings/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "x".repeat(43) }),
    });
    statuses.push(response.status);
    await response.text();
  }
  expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
  expect(statuses.at(-1)).toBe(429);
  const log = fs.readFileSync(path.join(env.LOG_DIR, "audit.log"), "utf8");
  expect(log.split("\n").filter((line) => line.includes('"scope":"agent_pairing_redeem"')).length).toBeGreaterThanOrEqual(20);
});
