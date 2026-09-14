/**
 * QDASHCOOKIE-003/004 + #34/#35 follow-up tests for the dashboard
 * session cookie. Pins these invariants:
 *
 *  - signSession() embeds the agent's session_version as `sv`, and
 *    rotateAgentKey() / deleteAgent() bump session_version so
 *    outstanding cookies fail the next request (#34).
 *  - verifySession() goes through crypto.timingSafeEqual over fixed-
 *    length raw HMAC buffers; tags whose decoded length is not exactly
 *    32 bytes are rejected before the compare (QDASHCOOKIE-003).
 *  - Expired / malformed-JSON / invalid-shape payloads → 401 (#35).
 *  - Origin guard accepts a request that carries only a Referer (no
 *    Origin) and rejects it when the Referer does not match (#35).
 *  - Logout cookie repeats the login cookie's attribute shape (HttpOnly,
 *    SameSite=Strict, Path=/api/dashboard) with Max-Age=0 (#35).
 *  - "Replay after logout": logout only clears the *browser's* copy of
 *    the cookie. The signed cookie value is still valid until expiry,
 *    rotation, or session-secret change. ADR-015 documents this; this
 *    test pins the documented behavior so a future change becomes a
 *    deliberate decision (#35).
 *  - Secure flag is set only when the request is HTTPS (real TLS) or
 *    came through a TRUSTED_PROXIES peer with x-forwarded-proto: https
 *    (QDASHCOOKIE-004). Spoofed x-forwarded-proto from an untrusted
 *    peer must NOT trigger Secure.
 *
 * The tests sign their own cookies using the same QOOPIA_SESSION_SECRET
 * the server uses, set at the top of this file before module imports
 * trigger sessionKey() resolution.
 */

// The session secret is pinned in tests/setup.ts (bunfig preload) so it
// is set before ANY test file's imports run, regardless of which file bun
// happens to schedule first. Setting it here would race with other test
// files that trigger dashboard-api.sessionKey() ahead of us — `_sessionKey`
// is module-level and caches the first resolution. CI hit this exact bug
// before the secret was hoisted into setup.ts.

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, rotateAgentKey, deleteAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { env } from "../src/utils/env.ts";

let server: Server;
let baseUrl = "";
let host = "";

let WORKSPACE_SLUG = "";
let WORKSPACE_ID = "";
let STEWARD_NAME = "";
let STEWARD_KEY = "";
let STEWARD_ID = "";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({
    name: "QDASH Hardening Test",
    slug: "qdash-hardening-test",
  });
  WORKSPACE_SLUG = ws.slug;
  WORKSPACE_ID = ws.id;

  const steward = createAgent({
    name: "qdash-hardening-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  });
  STEWARD_NAME = steward.name;
  STEWARD_KEY = steward.api_key;
  STEWARD_ID = steward.id;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  host = `127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// --- helpers ---------------------------------------------------------

const SECRET = process.env.QOOPIA_SESSION_SECRET!;

function b64uEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64uDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/** Sign an arbitrary payload using the same secret + algorithm the server
 *  uses, so we can mint expired / malformed / out-of-shape cookies. */
function signCookie(payload: object): string {
  const payloadB64 = b64uEncode(JSON.stringify(payload));
  const tag = crypto
    .createHmac("sha256", Buffer.from(SECRET, "utf8"))
    .update(payloadB64)
    .digest();
  return `${payloadB64}.${b64uEncode(tag)}`;
}

function getSetCookie(r: Response, name: string): string | null {
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

async function login(): Promise<{ cookieValue: string; setCookie: string }> {
  const r = await fetch(`${baseUrl}/api/dashboard/login`, {
    method: "POST",
    headers: { authorization: `Bearer ${STEWARD_KEY}` },
  });
  expect(r.status).toBe(200);
  const sc = getSetCookie(r, "qoopia_dash")!;
  const value = decodeURIComponent(sc.split(";")[0]!.split("=").slice(1).join("="));
  return { cookieValue: value, setCookie: sc };
}

// --- #34: session_version revocation ---------------------------------

describe("QDASHCOOKIE-#34: api_key rotation invalidates outstanding cookies", () => {
  test("baseline: cookie minted with current sv works", async () => {
    const { cookieValue } = await login();
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(cookieValue)}` },
    });
    expect(r.status).toBe(200);
  });

  test("rotateAgentKey() bumps session_version and kills outstanding cookies", async () => {
    const { cookieValue } = await login();

    // sanity — works before rotation
    const before = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(cookieValue)}` },
    });
    expect(before.status).toBe(200);

    rotateAgentKey(STEWARD_NAME, WORKSPACE_SLUG);

    const after = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(cookieValue)}` },
    });
    expect(after.status).toBe(401);
  });

  test("login with the new api_key issues a new working cookie", async () => {
    // The previous test rotated the steward's key, so STEWARD_KEY is dead.
    // Rotate again and grab the new key explicitly.
    const newKey = rotateAgentKey(STEWARD_NAME, WORKSPACE_SLUG);
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${newKey}` },
    });
    expect(r.status).toBe(200);
    const sc = getSetCookie(r, "qoopia_dash");
    expect(sc).not.toBeNull();
    const cookieValue = decodeURIComponent(
      sc!.split(";")[0]!.split("=").slice(1).join("="),
    );

    const verify = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(cookieValue)}` },
    });
    expect(verify.status).toBe(200);

    // keep STEWARD_KEY for any later tests
    STEWARD_KEY = newKey;
  });

  test("manually crafted cookie with stale sv is rejected", async () => {
    // Read current session_version, then craft a cookie with sv = current - 1.
    const row = db
      .prepare(`SELECT session_version FROM agents WHERE id = ?`)
      .get(STEWARD_ID) as { session_version: number };
    const stale = signCookie({
      agent_id: STEWARD_ID,
      sv: row.session_version - 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(stale)}` },
    });
    expect(r.status).toBe(401);
  });

  test("deleteAgent() bumps sv too (defense in depth)", async () => {
    // Use a throwaway agent so we don't kill the steward.
    const throwaway = createAgent({
      name: "qdash-hardening-throwaway",
      workspaceSlug: WORKSPACE_SLUG,
      type: "claude-privileged",
    });

    // Mint a cookie at the throwaway's current sv.
    const row1 = db
      .prepare(`SELECT session_version FROM agents WHERE id = ?`)
      .get(throwaway.id) as { session_version: number };
    const fresh = signCookie({
      agent_id: throwaway.id,
      sv: row1.session_version,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const before = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(fresh)}` },
    });
    expect(before.status).toBe(200);

    deleteAgent(throwaway.name, WORKSPACE_SLUG);

    const after = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(fresh)}` },
    });
    // active=0 alone would already kill it; this also pins that sv was bumped.
    expect(after.status).toBe(401);
    const row2 = db
      .prepare(`SELECT session_version FROM agents WHERE id = ?`)
      .get(throwaway.id) as { session_version: number };
    expect(row2.session_version).toBe(row1.session_version + 1);
  });
});

// --- QDASHCOOKIE-003: timingSafeEqual on fixed-length buffers --------

describe("QDASHCOOKIE-003: tag compare uses crypto.timingSafeEqual on 32-byte buffers", () => {
  test("truncated tag (31 bytes) → 401, no throw", async () => {
    const payload = {
      agent_id: STEWARD_ID,
      sv: (db
        .prepare(`SELECT session_version FROM agents WHERE id = ?`)
        .get(STEWARD_ID) as { session_version: number }).session_version,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const payloadB64 = b64uEncode(JSON.stringify(payload));
    // Real tag, then strip a byte off the raw HMAC so the decoded length is 31.
    const fullTag = crypto
      .createHmac("sha256", Buffer.from(SECRET, "utf8"))
      .update(payloadB64)
      .digest();
    const truncated = b64uEncode(fullTag.subarray(0, 31));
    const value = `${payloadB64}.${truncated}`;
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("oversize tag (40 bytes) → 401, no throw", async () => {
    const payload = {
      agent_id: STEWARD_ID,
      sv: (db
        .prepare(`SELECT session_version FROM agents WHERE id = ?`)
        .get(STEWARD_ID) as { session_version: number }).session_version,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const payloadB64 = b64uEncode(JSON.stringify(payload));
    const padded = b64uEncode(Buffer.alloc(40, 0xab));
    const value = `${payloadB64}.${padded}`;
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("tampered (same length, wrong bytes) tag → 401", async () => {
    const payload = {
      agent_id: STEWARD_ID,
      sv: (db
        .prepare(`SELECT session_version FROM agents WHERE id = ?`)
        .get(STEWARD_ID) as { session_version: number }).session_version,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const payloadB64 = b64uEncode(JSON.stringify(payload));
    const tampered = b64uEncode(Buffer.alloc(32, 0xcd));
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(`${payloadB64}.${tampered}`)}` },
    });
    expect(r.status).toBe(401);
  });
});

// --- #35: expired / malformed / invalid-shape payloads ---------------

describe("QDASHCOOKIE-#35: expired / malformed / invalid payloads → 401", () => {
  function currentSv(): number {
    return (db
      .prepare(`SELECT session_version FROM agents WHERE id = ?`)
      .get(STEWARD_ID) as { session_version: number }).session_version;
  }

  test("expired cookie (exp in past) → 401", async () => {
    const value = signCookie({
      agent_id: STEWARD_ID,
      sv: currentSv(),
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("malformed JSON in payload half → 401", async () => {
    const broken = b64uEncode("not-json{");
    const tag = crypto
      .createHmac("sha256", Buffer.from(SECRET, "utf8"))
      .update(broken)
      .digest();
    const value = `${broken}.${b64uEncode(tag)}`;
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("invalid exp shape (NaN) → 401", async () => {
    const value = signCookie({
      agent_id: STEWARD_ID,
      sv: currentSv(),
      exp: "tomorrow",
    });
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("missing sv field → 401", async () => {
    const value = signCookie({
      agent_id: STEWARD_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("negative sv → 401", async () => {
    const value = signCookie({
      agent_id: STEWARD_ID,
      sv: -1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("non-integer sv → 401", async () => {
    const value = signCookie({
      agent_id: STEWARD_ID,
      sv: 1.5,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(value)}` },
    });
    expect(r.status).toBe(401);
  });

  test("missing dot separator (just signed payload) → 401", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=onlypayloadnodot` },
    });
    expect(r.status).toBe(401);
  });
});

// --- #35: Origin guard with Referer-only -----------------------------

describe("QDASHCOOKIE-#35: Origin guard accepts Referer-only when matching", () => {
  test("Referer matching request Host (no Origin) → /login allowed", async () => {
    // Server's PUBLIC_URL is localhost:3737 by default; but the originAllowed
    // helper also accepts the request's own Host header. We use that here
    // because the test server binds to a random ephemeral port.
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${STEWARD_KEY}`,
        referer: `http://${host}/dashboard/`,
      },
    });
    expect(r.status).toBe(200);
    expect(getSetCookie(r, "qoopia_dash")).not.toBeNull();
  });

  test("Referer pointing at attacker.example (no Origin) → /login forbidden", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${STEWARD_KEY}`,
        referer: "https://attacker.example/path",
      },
    });
    expect(r.status).toBe(403);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
  });
});

// --- #35: logout cookie attribute shape + replay-after-logout --------

describe("QDASHCOOKIE-#35: logout cookie attributes and replay semantics", () => {
  test("/logout Set-Cookie carries the same attribute shape with Max-Age=0", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/logout`, {
      method: "POST",
    });
    expect(r.status).toBe(200);
    const sc = getSetCookie(r, "qoopia_dash")!;
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Path=/api/dashboard");
    expect(sc).toContain("Max-Age=0");
  });

  test("replay after logout: cookie is revoked server-side (QSA-E)", async () => {
    // QSA-E / Codex QSA-005 (2026-04-28): logout now bumps the agent's
    // session_version, so any copy of the pre-logout cookie fails the
    // sv check and gets 401 on its next request. Previously the
    // stateless cookie remained valid until rotation/deactivation/
    // session-secret rotation/expiry — see ADR-015 update.
    const { cookieValue } = await login();

    // Authenticated logout: send the cookie so the server can identify
    // the agent and bump session_version. (The browser does this
    // automatically because the logout button lives behind the same
    // cookie scope.)
    const lr = await fetch(`${baseUrl}/api/dashboard/logout`, {
      method: "POST",
      headers: { cookie: `qoopia_dash=${encodeURIComponent(cookieValue)}` },
    });
    expect(lr.status).toBe(200);

    const replay = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(cookieValue)}` },
    });
    expect(replay.status).toBe(401);
  });

  test("logout without cookie: still 200 and idempotent (no agent to revoke)", async () => {
    // Idempotence: calling /logout with no cookie must remain a 200 so
    // the browser logout flow stays smooth even on stale state.
    const r = await fetch(`${baseUrl}/api/dashboard/logout`, {
      method: "POST",
    });
    expect(r.status).toBe(200);
  });

  test("logout with tampered cookie: still 200, no other agent affected", async () => {
    // If the cookie can't be verified, we can't identify the agent and
    // therefore must not bump anyone's session_version.
    const { cookieValue: legitCookie } = await login();

    // Send garbage cookie — server can't verify it; should not affect
    // the legit cookie's validity.
    const lr = await fetch(`${baseUrl}/api/dashboard/logout`, {
      method: "POST",
      headers: { cookie: "qoopia_dash=tampered.value.here" },
    });
    expect(lr.status).toBe(200);

    const probe = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { cookie: `qoopia_dash=${encodeURIComponent(legitCookie)}` },
    });
    expect(probe.status).toBe(200);
  });
});

// --- QDASHCOOKIE-004: Secure flag + proxy semantics ------------------

describe("QDASHCOOKIE-004: Secure flag respects TRUST_PROXY/TRUSTED_PROXIES", () => {
  test("plain HTTP request with no proxy trust → no Secure", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    expect(r.status).toBe(200);
    const sc = getSetCookie(r, "qoopia_dash")!;
    expect(sc).not.toContain("Secure");
  });

  test("trusted proxy + x-forwarded-proto: https → Secure flag set", async () => {
    const prevTrust = env.TRUST_PROXY;
    const prevList = env.TRUSTED_PROXIES;
    env.TRUST_PROXY = true;
    env.TRUSTED_PROXIES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
    try {
      const r = await fetch(`${baseUrl}/api/dashboard/login`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${STEWARD_KEY}`,
          "x-forwarded-proto": "https",
        },
      });
      expect(r.status).toBe(200);
      const sc = getSetCookie(r, "qoopia_dash")!;
      expect(sc).toContain("Secure");
    } finally {
      env.TRUST_PROXY = prevTrust;
      env.TRUSTED_PROXIES = prevList;
    }
  });

  test("untrusted peer spoofing x-forwarded-proto: https → Secure NOT set", async () => {
    const prevTrust = env.TRUST_PROXY;
    const prevList = env.TRUSTED_PROXIES;
    // Trust enabled but localhost is NOT in the whitelist — simulates an
    // attacker reaching the listener directly while a proxy lives elsewhere.
    env.TRUST_PROXY = true;
    env.TRUSTED_PROXIES = ["10.10.10.10"];
    try {
      const r = await fetch(`${baseUrl}/api/dashboard/login`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${STEWARD_KEY}`,
          "x-forwarded-proto": "https",
        },
      });
      expect(r.status).toBe(200);
      const sc = getSetCookie(r, "qoopia_dash")!;
      expect(sc).not.toContain("Secure");
    } finally {
      env.TRUST_PROXY = prevTrust;
      env.TRUSTED_PROXIES = prevList;
    }
  });

  test("TRUST_PROXY=false ignores x-forwarded-proto entirely", async () => {
    const prevTrust = env.TRUST_PROXY;
    env.TRUST_PROXY = false;
    try {
      const r = await fetch(`${baseUrl}/api/dashboard/login`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${STEWARD_KEY}`,
          "x-forwarded-proto": "https",
        },
      });
      expect(r.status).toBe(200);
      const sc = getSetCookie(r, "qoopia_dash")!;
      expect(sc).not.toContain("Secure");
    } finally {
      env.TRUST_PROXY = prevTrust;
    }
  });
});

// --- QDASHCOOKIE-005: /login binds cookie sv to api_key_hash snapshot ----
//
// Codex flagged: the original handler authenticated the Bearer first, then
// did a separate SELECT session_version before signing. A rotation that
// commits between those two operations would mint a cookie carrying the
// new sv from a pre-rotation auth. The fix reads api_key_hash AND
// session_version in one SELECT and constant-time-compares the row's hash
// to sha256(presented bearer); if rotation completed mid-flight the hash
// compare fails and no cookie is issued.
//
// We can't deterministically inject a commit between two synchronous
// bun:sqlite calls in the same process, but we CAN pin the OUTPUT
// invariants the fix guarantees:
//
//   (1) the cookie minted at login carries `sv` equal to the row's
//       current session_version (i.e. the snapshot read is fresh, not
//       stale from a cached pre-rotation read), and
//   (2) login with a stale Bearer (the api_key has since been rotated)
//       returns 401 and DOES NOT issue Set-Cookie.

describe("QDASHCOOKIE-005: /login binds cookie sv to api_key_hash snapshot", () => {
  function payloadOf(cookieValue: string): { agent_id: string; sv: number; exp: number } {
    const dot = cookieValue.indexOf(".");
    expect(dot).toBeGreaterThan(0);
    const payloadB64 = cookieValue.slice(0, dot);
    const json = b64uDecode(payloadB64).toString("utf8");
    return JSON.parse(json);
  }

  test("cookie carries the current session_version at login (fresh snapshot)", async () => {
    // Bump session_version once via rotation — STEWARD_KEY now points to the
    // new key, so a successful login should see the bumped sv in the cookie.
    const newKey = rotateAgentKey(STEWARD_NAME, WORKSPACE_SLUG);
    STEWARD_KEY = newKey;
    const liveSv = (db
      .prepare(`SELECT session_version FROM agents WHERE id = ?`)
      .get(STEWARD_ID) as { session_version: number }).session_version;

    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    expect(r.status).toBe(200);
    const sc = getSetCookie(r, "qoopia_dash")!;
    const cookieValue = decodeURIComponent(
      sc.split(";")[0]!.split("=").slice(1).join("="),
    );
    const p = payloadOf(cookieValue);
    expect(p.agent_id).toBe(STEWARD_ID);
    expect(p.sv).toBe(liveSv);
  });

  test("login with a stale Bearer (rotated away) → 401, no Set-Cookie", async () => {
    // Capture the current Bearer, then rotate so that key becomes stale.
    const staleKey = STEWARD_KEY;
    const newKey = rotateAgentKey(STEWARD_NAME, WORKSPACE_SLUG);
    STEWARD_KEY = newKey;

    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${staleKey}` },
    });
    expect(r.status).toBe(401);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
  });

  test("non-Bearer header shape is rejected without DB access", async () => {
    // The /login handler strips `Bearer ` case-insensitively before hashing
    // for the post-authenticate recheck. authenticate() rejects unknown
    // schemes upstream, so we should never get to the snapshot SELECT;
    // pin that invariant: 401, no Set-Cookie.
    const r = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: "POST",
      headers: { authorization: `Basic ${STEWARD_KEY}` },
    });
    expect(r.status).toBe(401);
    expect(getSetCookie(r, "qoopia_dash")).toBeNull();
  });
});
