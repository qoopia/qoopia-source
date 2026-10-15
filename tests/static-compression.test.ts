// A4-22: the dashboard's scripts and styles were sent uncompressed (~650 KB on a first visit).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { runMigrations } from "../src/db/migrate.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server, baseUrl = "";
beforeAll(async () => {
  runMigrations();
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const raw = (path: string, encoding: string) => fetch(baseUrl + path, { headers: { "accept-encoding": encoding }, decompress: false } as RequestInit);
const file = readFileSync(new URL("../src/public/brand/dashboard.js", import.meta.url));

test("text assets are sent brotli- or gzip-compressed as the browser asks; the font is not", async () => {
  const br = await raw("/brand/dashboard.js", "gzip, deflate, br");
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("vary")).toContain("accept-encoding");
  const brBody = Buffer.from(await br.arrayBuffer());
  expect(brBody.length).toBeLessThan(file.length / 3);
  expect(brotliDecompressSync(brBody).equals(file)).toBe(true);
  const gz = await raw("/brand/dashboard.js", "gzip");
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).equals(file)).toBe(true);
  const plain = await raw("/brand/dashboard.js", "identity");
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(Buffer.from(await plain.arrayBuffer()).equals(file)).toBe(true);
  expect((await raw("/brand/Manrope.ttf", "br")).headers.get("content-encoding")).toBeNull();
});
