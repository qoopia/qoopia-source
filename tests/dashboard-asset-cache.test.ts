/**
 * F-306: dashboard.html names every asset with ?v=<content revision>. A request for the
 * current revision is cached for a year (immutable), so a reload no longer downloads
 * ~600 KB again; unversioned or stale-revision URLs and the HTML itself stay no-cache.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server;
let base = "";
beforeAll(async () => {
  runMigrations();
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

test("the current revision of a dashboard asset is immutable; everything else revalidates", async () => {
  const page = await fetch(`${base}/dashboard`);
  expect(page.headers.get("cache-control")).toBe("no-cache");
  const version = page.headers.get("x-qoopia-dashboard-version")!;
  expect(await page.text()).toContain(`/brand/dashboard.js?v=${version}`);
  for (const asset of ["dashboard.js", "dashboard.css", "i18n.js"]) {
    const current = await fetch(`${base}/brand/${asset}?v=${version}`);
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  }
  expect((await fetch(`${base}/brand/dashboard.js`)).headers.get("cache-control")).toBe("no-cache");
  expect((await fetch(`${base}/brand/dashboard.js?v=stale-revision`)).headers.get("cache-control")).toBe("no-cache");
});
