/**
 * Characterisation tests for HTTP routes that had zero test coverage.
 *
 * These lock in the CURRENT observable contract of six endpoints so that the
 * planned http.ts split cannot change them silently:
 *
 *   GET  /ingest/allowlist            ingest-daemon only, workspace-scoped
 *   POST /ingest/session              ingest-daemon only, hard workspace isolation
 *   POST /memory/continuity           Bearer + write-low scope
 *   *    /api/dashboard/authority/*   cookie -> /api/v1/* proxy, CSRF on mutation
 *   GET  /api/dashboard/bridges       owner cookie only
 *   GET  /api/dashboard/connections   owner cookie only, read-only
 *
 * They are deliberately written against status codes and error identifiers
 * rather than payload shapes: the goal is to detect a moved or dropped guard,
 * not to freeze response bodies.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server;
let baseUrl = "";

let INGEST_KEY = "";
let STANDARD_KEY = "";
let OWNER_KEY = "";
let TARGET_AGENT_ID = "";
let FOREIGN_AGENT_ID = "";

beforeAll(async () => {
  runMigrations();

  const ws = createWorkspace({ name: "Wave0 Home", slug: "wave0-home" });
  const foreign = createWorkspace({ name: "Wave0 Foreign", slug: "wave0-foreign" });

  // The dashboard endpoints below resolve the caller through localOwner(),
  // which requires exactly one bootstrapped human owner on the instance.
  // Without it every one of them answers 400 regardless of agent type.
  OWNER_KEY = bootstrapOwner(db, "Wave0 owner", undefined, ws.id).api_key;

  INGEST_KEY = createAgent({
    name: "wave0-ingest",
    workspaceSlug: ws.slug,
    type: "ingest-daemon",
  }).api_key;

  const standard = createAgent({ name: "wave0-standard", workspaceSlug: ws.slug });
  STANDARD_KEY = standard.api_key;
  TARGET_AGENT_ID = standard.id;

  FOREIGN_AGENT_ID = createAgent({
    name: "wave0-foreign-agent",
    workspaceSlug: foreign.slug,
  }).id;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function getSetCookie(r: Response, name: string): string | null {
  const all =
    typeof (r.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (r.headers as { getSetCookie: () => string[] }).getSetCookie()
      : [r.headers.get("set-cookie") || ""];
  for (const c of all) {
    if (c && c.split(";")[0]!.trim().startsWith(`${name}=`)) return c;
  }
  return null;
}

/** Mint a real owner dashboard cookie through the login endpoint. */
async function dashboardCookie(): Promise<string> {
  const r = await fetch(`${baseUrl}/api/dashboard/login`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_KEY}` },
  });
  expect(r.status).toBe(200);
  const sc = getSetCookie(r, "qoopia_dash");
  expect(sc).not.toBeNull();
  const value = decodeURIComponent(sc!.split(";")[0]!.split("=").slice(1).join("="));
  return `qoopia_dash=${encodeURIComponent(value)}`;
}

function ingestBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    attributed_agent_id: TARGET_AGENT_ID,
    session_id: `wave0-session-${Math.random().toString(36).slice(2)}`,
    uuid: crypto.randomUUID(),
    role: "user",
    content: "wave0 characterisation message",
    ...overrides,
  });
}

// --- GET /ingest/allowlist ------------------------------------------------

describe("GET /ingest/allowlist", () => {
  test("rejects unauthenticated callers with 403", async () => {
    const r = await fetch(`${baseUrl}/ingest/allowlist`);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("forbidden");
  });

  test("rejects a valid non-ingest-daemon key with 403", async () => {
    const r = await fetch(`${baseUrl}/ingest/allowlist`, {
      headers: { authorization: `Bearer ${STANDARD_KEY}` },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("forbidden");
  });

  test("returns an array for an ingest-daemon key", async () => {
    const r = await fetch(`${baseUrl}/ingest/allowlist`, {
      headers: { authorization: `Bearer ${INGEST_KEY}` },
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });

  test("is not served for non-GET methods", async () => {
    const r = await fetch(`${baseUrl}/ingest/allowlist`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_KEY}` },
    });
    expect(r.status).toBe(404);
  });
});

// --- POST /ingest/session -------------------------------------------------

describe("POST /ingest/session", () => {
  test("rejects unauthenticated callers with 403", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      body: ingestBody(),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("forbidden");
  });

  test("rejects a non-ingest-daemon key with 403", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${STANDARD_KEY}` },
      body: ingestBody(),
    });
    expect(r.status).toBe(403);
  });

  test("rejects malformed JSON with 400 invalid_json", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_json");
  });

  test("rejects a missing required field with 400 missing_fields", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: ingestBody({ content: undefined }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("missing_fields");
  });

  test("rejects an unsupported role with 400 invalid_role", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: ingestBody({ role: "system" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_role");
  });

  test("returns 404 for an unknown attributed agent", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: ingestBody({ attributed_agent_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ" }),
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("agent_not_found");
  });

  // The guard this test protects is the reason the endpoint exists in this
  // shape: a stolen ingest token must not be able to write into another
  // workspace even when the caller knows a valid foreign agent id.
  test("refuses to write into another workspace with 403 workspace_mismatch", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: ingestBody({ attributed_agent_id: FOREIGN_AGENT_ID }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("workspace_mismatch");
  });

  test("accepts a well-formed message for an agent in its own workspace", async () => {
    const r = await fetch(`${baseUrl}/ingest/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: ingestBody(),
    });
    expect(r.status).toBe(200);
  });
});

// --- POST /memory/continuity ---------------------------------------------

describe("POST /memory/continuity", () => {
  test("rejects unauthenticated callers with 401", async () => {
    const r = await fetch(`${baseUrl}/memory/continuity`, {
      method: "POST",
      body: "{}",
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("unauthenticated");
  });

  test("refuses a malformed body for an authenticated caller", async () => {
    const r = await fetch(`${baseUrl}/memory/continuity`, {
      method: "POST",
      headers: { authorization: `Bearer ${STANDARD_KEY}` },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("Continuity request refused");
  });

  test("sends no-store so continuity replies are never cached", async () => {
    const r = await fetch(`${baseUrl}/memory/continuity`, {
      method: "POST",
      body: "{}",
    });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

// --- /api/dashboard/authority/* ------------------------------------------

describe("/api/dashboard/authority/*", () => {
  test("rejects callers without a dashboard session with 401", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/authority/notes`);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe("UNAUTHENTICATED");
  });

  test("proxies an authenticated GET to the authority API", async () => {
    const cookie = await dashboardCookie();
    const r = await fetch(`${baseUrl}/api/dashboard/authority/notes`, {
      headers: { cookie },
    });
    // The proxy must reach the authority layer rather than the 401/404 of the
    // outer router; the authority's own status is whatever it decides.
    expect(r.status).not.toBe(401);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("refuses a mutation without the same-origin CSRF header", async () => {
    const cookie = await dashboardCookie();
    const r = await fetch(`${baseUrl}/api/dashboard/authority/notes`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("FORBIDDEN");
  });
});

// --- GET /api/dashboard/bridges ------------------------------------------

describe("/api/dashboard/bridges", () => {
  test("rejects callers without a cookie with 401", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/bridges`);
    expect(r.status).toBe(401);
  });

  test("rejects a Bearer key: this endpoint is cookie-only", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/bridges`, {
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    expect(r.status).toBe(401);
  });

  test("serves state to an owner cookie and never caches it", async () => {
    const cookie = await dashboardCookie();
    const r = await fetch(`${baseUrl}/api/dashboard/bridges`, {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("refuses a POST without the same-origin CSRF header", async () => {
    const cookie = await dashboardCookie();
    const r = await fetch(`${baseUrl}/api/dashboard/bridges`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(403);
  });
});

// --- GET /api/dashboard/connections --------------------------------------

describe("/api/dashboard/connections", () => {
  test("rejects callers without a cookie with 401", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/connections`);
    expect(r.status).toBe(401);
  });

  test("rejects a Bearer key: this endpoint is cookie-only", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/connections`, {
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    expect(r.status).toBe(401);
  });

  test("serves state to an owner cookie", async () => {
    const cookie = await dashboardCookie();
    const r = await fetch(`${baseUrl}/api/dashboard/connections`, {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("is read-only: a POST is answered with 405", async () => {
    const cookie = await dashboardCookie();
    const r = await fetch(`${baseUrl}/api/dashboard/connections`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(405);
  });
});
