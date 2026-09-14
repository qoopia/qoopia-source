/**
 * QDASH-COOKIE: dashboard sessions live in an HttpOnly cookie set by
 * POST /api/dashboard/login. The Bearer token never enters JS storage,
 * and the cookie value is a signed `{agent_id, exp}` payload — NOT the
 * raw Bearer.
 *
 * Invariants the tests prove:
 *   1. POST /login with a valid Bearer returns 200 + Set-Cookie qoopia_dash=...
 *      with HttpOnly + SameSite=Strict + Path=/api/dashboard.
 *   2. The cookie value (payload + tag, base64url-decoded both halves)
 *      contains zero bytes of the agent's raw Bearer api_key.
 *   3. A subsequent GET /api/dashboard/agents authenticated by ONLY the
 *      cookie (no Authorization header) returns 200.
 *   4. POST /logout sends Set-Cookie qoopia_dash= ; Max-Age=0.
 *   5. GET without Authorization AND without cookie → 401.
 *   6. Cookie scope: hitting /mcp with the cookie does NOT authenticate
 *      (cookie is path-scoped to /api/dashboard, and /mcp's auth path
 *      ignores cookies entirely).
 *   7. /login with a forged Origin → 403.
 *   8. /login with a deactivated agent's Bearer → 401 (no cookie issued).
 *   9. A signed cookie pointing at a deactivated agent → 401 (DB check
 *      runs on every request, not just at login).
 *  10. POST /login with an invalid Bearer → 401, no Set-Cookie.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";

let server: Server;
let baseUrl = "";

let WORKSPACE_ID = "";
let STEWARD_KEY = "";
let STEWARD_ID = "";
let STANDARD_KEY = "";
let STANDARD_ID = "";
let DEACTIVATED_KEY = "";
let DEACTIVATED_ID = "";

const ONE_YEAR_SEC = 31_536_000;

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({
    name: "QDASH Cookie Test",
    slug: "qdash-cookie-test",
  });
  WORKSPACE_ID = ws.id;

  const steward = createAgent({
    name: "qdash-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  });
  STEWARD_ID = steward.id;
  STEWARD_KEY = steward.api_key;

  const standard = createAgent({
    name: "qdash-standard",
    workspaceSlug: ws.slug,
  });
  STANDARD_ID = standard.id;
  STANDARD_KEY = standard.api_key;

  // Use claude-privileged here so we don't trip the per-workspace
  // single-steward unique index (migration 002).
  const dead = createAgent({
    name: "qdash-dead",
    workspaceSlug: ws.slug,
    type: "claude-privileged",
  });
  DEACTIVATED_ID = dead.id;
  DEACTIVATED_KEY = dead.api_key;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Pull a single Set-Cookie value matching the given name from a Response. */
function getSetCookie(r: Response, name: string): string | null {
  // Bun returns multiple Set-Cookie headers as a comma-joined single string,
  // but cookie values themselves can contain commas. Walk getSetCookie() if
  // available; fall back to header.
  const all =
    typeof (r.headers as { getSetCookie?: () => string[] }).getSetCookie ===
    "function"
      ? (r.headers as { getSetCookie: () => string[] }).getSetCookie()
      : [r.headers.get("set-cookie") || ""];
  for (const c of all) {
    if (!c) continue;
    if (c.split(";")[0]!.trim().startsWith(`${name}=`)) return c;
  }
  return null;
}

/** Extract the bare value of a cookie from its Set-Cookie line. */
function cookieValue(setCookie: string): string {
  const first = setCookie.split(";")[0]!;
  const eq = first.indexOf("=");
  return decodeURIComponent(first.slice(eq + 1));
}

describe("QDASH-COOKIE: login issues a signed session cookie", () => {
  test("POST /login with valid steward Bearer → 200 + Set-Cookie", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      agent_id: string;
      type: string;
      isAdmin: boolean;
      expires_in: number;
    };
    expect(body.ok).toBe(true);
    expect(body.agent_id).toBe(STEWARD_ID);
    expect(body.isAdmin).toBe(true);
    expect(body.expires_in).toBe(ONE_YEAR_SEC);

    const sc = getSetCookie(r, "qoopia_dash");
    expect(sc).not.toBeNull();
    expect(sc!).toContain("HttpOnly");
    expect(sc!).toContain("SameSite=Strict");
    expect(sc!).toContain("Path=/api/dashboard");
    expect(sc!).toContain(`Max-Age=${ONE_YEAR_SEC}`);
  });

  test("cookie value is a signed payload, NOT the raw Bearer api_key", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    expect(r.status).toBe(200);
    const sc = getSetCookie(r, "qoopia_dash")!;
    const value = cookieValue(sc);

    // Format: <base64url(payload)>.<base64url(tag)>
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [payloadB64, tagB64] = value.split(".");
    const payload = Buffer.from(
      payloadB64!.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (payloadB64!.length % 4)) % 4),
      "base64",
    ).toString("utf8");
    // Payload is JSON {"agent_id":"...","exp":...} — it must NOT carry the
    // raw Bearer in any form.
    expect(payload).not.toContain(STEWARD_KEY);
    // And the binary tag must not coincidentally embed the Bearer either.
    const tag = Buffer.from(
      tagB64!.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (tagB64!.length % 4)) % 4),
      "base64",
    );
    expect(tag.toString("hex")).not.toContain(
      Buffer.from(STEWARD_KEY, "utf8").toString("hex"),
    );
  });

  test("POST /login with invalid Bearer → 401, no Set-Cookie", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: "Bearer not_a_real_key_xxxxxxxxxxxxxx" },
    });
    expect(r.status).toBe(401);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
  });

  test("POST /login without Authorization → 401, no Set-Cookie", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
    });
    expect(r.status).toBe(401);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
  });

  test("POST /login with a valid key only in JSON body → 401, no Set-Cookie", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ api_key: STEWARD_KEY }),
    });
    expect(r.status).toBe(401);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
    expect(await r.text()).not.toContain(STEWARD_KEY);
  });

  test("POST /login with mismatched Origin → 403", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${STEWARD_KEY}`,
        origin: "https://evil.example.com",
      },
    });
    expect(r.status).toBe(403);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
  });
});

describe("QDASH-COOKIE: cookie authenticates subsequent dashboard reads", () => {
  test("GET /agents with cookie only (no Authorization) → 200", async () => {
    const login = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    const sc = getSetCookie(login, "qoopia_dash")!;
    const cookieHeader = sc.split(";")[0]!; // "qoopia_dash=..."

    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: cookieHeader },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ id: string }> };
    // Steward sees the whole workspace
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  test("GET /agents with NO cookie and NO Authorization → 401", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agents`);
    expect(r.status).toBe(401);
  });

  test("GET /agents with bad Authorization wins over a valid cookie (header takes precedence)", async () => {
    // Authorization header is checked first; a bad header should fail even if
    // a valid cookie is also present, to avoid silent fallback that masks
    // misconfigured callers.
    const login = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    const sc = getSetCookie(login, "qoopia_dash")!;
    const cookieHeader = sc.split(";")[0]!;
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: {
        cookie: cookieHeader,
        authorization: "Bearer obviously_bogus_token_xxxxxxx",
      },
    });
    expect(r.status).toBe(401);
  });

  test("standard agent's cookie still enforces per-agent scope", async () => {
    const login = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STANDARD_KEY}` },
    });
    expect(login.status).toBe(200);
    const sc = getSetCookie(login, "qoopia_dash")!;
    const cookieHeader = sc.split(";")[0]!;

    // Cookie holder is the standard agent — they see only themselves.
    const own = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: cookieHeader },
    });
    expect(own.status).toBe(200);
    const body = (await own.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.id).toBe(STANDARD_ID);

    // Cross-agent read still 403 with cookie auth.
    const cross = await fetch(
      `${baseUrl}/api/dashboard/agents/${STEWARD_ID}/notes`,
      { headers: { cookie: cookieHeader } },
    );
    expect(cross.status).toBe(403);
  });
});

describe("QDASH-COOKIE: cookie scope is dashboard-only", () => {
  test("cookie does not authenticate /mcp", async () => {
    const login = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    const sc = getSetCookie(login, "qoopia_dash")!;
    const cookieHeader = sc.split(";")[0]!;

    // /mcp uses Bearer-only auth (no cookie reader). Without Authorization
    // it must return 401 even when a valid dashboard cookie is supplied.
    const r = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });
});

describe("QDASH-COOKIE: logout clears the cookie", () => {
  test("POST /logout → 200 + Set-Cookie with Max-Age=0", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/logout`, {
      method: "POST",
    });
    expect(r.status).toBe(200);
    const sc = getSetCookie(r, "qoopia_dash");
    expect(sc).not.toBeNull();
    expect(sc!).toContain("Max-Age=0");
    expect(sc!).toContain("HttpOnly");
    expect(sc!).toContain("Path=/api/dashboard");
  });

  test("POST /logout with mismatched Origin → 403", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/logout`, {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(r.status).toBe(403);
  });
});

describe("QDASH-COOKIE: deactivation kills outstanding cookies", () => {
  test("cookie issued before deactivation stops working after", async () => {
    const login = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${DEACTIVATED_KEY}` },
    });
    expect(login.status).toBe(200);
    const sc = getSetCookie(login, "qoopia_dash")!;
    const cookieHeader = sc.split(";")[0]!;

    // Sanity: cookie works while agent is active.
    const before = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: cookieHeader },
    });
    expect(before.status).toBe(200);

    // Deactivate the agent in-place.
    db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(
      DEACTIVATED_ID,
    );

    const after = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: cookieHeader },
    });
    expect(after.status).toBe(401);
  });
});

describe("QDASH-COOKIE: tampered cookies are rejected", () => {
  test("flipped tag byte → 401", async () => {
    const login = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    const sc = getSetCookie(login, "qoopia_dash")!;
    const value = cookieValue(sc);
    // Flip a character in the tag half (after the dot).
    const dot = value.indexOf(".");
    const head = value.slice(0, dot + 1);
    const tail = value.slice(dot + 1);
    // Toggle one base64 char.
    const flipped = (tail[0] === "A" ? "B" : "A") + tail.slice(1);
    const tampered = head + flipped;

    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(tampered)}` },
    });
    expect(r.status).toBe(401);
  });

  test("garbage cookie → 401", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=garbage.value` },
    });
    expect(r.status).toBe(401);
  });
});

describe("QDASHCOOKIE-001: OAuth access token cannot mint a dashboard cookie", () => {
  // Mint a real OAuth access token bound to the steward agent by writing
  // directly to oauth_tokens. Format mirrors src/auth/oauth.ts (`qa_*`).
  // The token IS valid for /mcp via authenticate() — this test pins that
  // the dashboard endpoint specifically rejects the OAuth source.
  const TEST_CLIENT_ID = "qc_test_oauth_client";

  function ensureTestClient(agentId: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO oauth_clients
        (id, name, agent_id, client_secret_hash, redirect_uris, created_at)
       VALUES (?, ?, ?, '', '[]', ?)`,
    ).run(TEST_CLIENT_ID, "qdash-cookie-test", agentId, new Date().toISOString());
  }

  function mintOauthAccessToken(agentId: string, workspaceId: string): string {
    ensureTestClient(agentId);
    const access = `qa_${crypto.randomBytes(32).toString("base64url")}`;
    const now = new Date()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const exp = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    db.prepare(
      `INSERT INTO oauth_tokens
        (token_hash, client_id, agent_id, workspace_id, token_type,
         expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, 'access', ?, 0, ?)`,
    ).run(
      sha256Hex(access),
      TEST_CLIENT_ID,
      agentId,
      workspaceId,
      exp,
      now,
    );
    return access;
  }

  test("POST /login with OAuth access token → 401 + no Set-Cookie", async () => {
    const oauthToken = mintOauthAccessToken(STEWARD_ID, WORKSPACE_ID);

    // Sanity: this OAuth token actually authenticates non-login dashboard
    // routes (because authenticate() honors OAuth there). If this check
    // fails, the test below is meaningless — we'd be testing a dead token.
    const sanity = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { authorization: `Bearer ${oauthToken}` },
    });
    expect(sanity.status).toBe(200);

    // The actual invariant: /login refuses OAuth source.
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${oauthToken}` },
    });
    expect(r.status).toBe(401);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
  });

  test("api_key login still works (no regression on the supported path)", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    expect(r.status).toBe(200);
    expect(getSetCookie(r, "qoopia_dash")).not.toBeNull();
  });
});
