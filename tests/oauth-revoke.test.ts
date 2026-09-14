import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";
import { authLimiter } from "../src/utils/rate-limit.ts";
import { env } from "../src/utils/env.ts";

let server: Server;
let baseUrl = "";
let WORKSPACE_ID = "";
let AGENT_ID = "";
let AGENT_KEY = "";

async function registerConfidentialClient(): Promise<{
  client_id: string;
  client_secret: string;
}> {
  const r = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${AGENT_KEY}`,
    },
    body: JSON.stringify({
      client_name: `oauth-revoke-${Date.now()}`,
      redirect_uris: ["https://example.com/revoke-cb"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string; client_secret: string };
}

function mintAccessToken(clientId: string): string {
  const access = `qa_${crypto.randomBytes(32).toString("base64url")}`;
  const now = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const exp = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  db.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, client_id, agent_id, workspace_id, token_type, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, 'access', ?, 0, ?)`,
  ).run(
    sha256Hex(access),
    clientId,
    AGENT_ID,
    WORKSPACE_ID,
    exp,
    now,
  );
  return access;
}

async function revoke(params: {
  token: string;
  clientId: string;
  clientSecret?: string;
}): Promise<Response> {
  const form = new URLSearchParams({
    token: params.token,
    client_id: params.clientId,
  });
  if (params.clientSecret !== undefined) {
    form.set("client_secret", params.clientSecret);
  }
  return fetch(`${baseUrl}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function readAuditRows(auditPath: string, offset: number): Record<string, unknown>[] {
  const lines = fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, "utf8").slice(offset).split("\n")
    : [];
  return lines
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((row): row is Record<string, unknown> => row !== null);
}

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({
    name: "OAuth Revoke WS",
    slug: "oauth-revoke-ws",
  });
  WORKSPACE_ID = ws.id;
  const agent = createAgent({
    name: "oauth-revoke-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  });
  AGENT_ID = agent.id;
  AGENT_KEY = agent.api_key;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  authLimiter.resetForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("/oauth/revoke hardening", () => {
  test("21st request from one IP is rate-limited", async () => {
    const { client_id, client_secret } = await registerConfidentialClient();
    const token = mintAccessToken(client_id);
    authLimiter.resetForTests();

    for (let i = 0; i < 20; i++) {
      const r = await revoke({
        token,
        clientId: client_id,
        clientSecret: client_secret,
      });
      expect(r.status).toBe(200);
    }

    const limited = await revoke({
      token,
      clientId: client_id,
      clientSecret: client_secret,
    });
    expect(limited.status).toBe(429);
  });

  test("response body does not leak revoked status", async () => {
    const { client_id, client_secret } = await registerConfidentialClient();
    const token = mintAccessToken(client_id);

    const first = await revoke({
      token,
      clientId: client_id,
      clientSecret: client_secret,
    });
    const second = await revoke({
      token,
      clientId: client_id,
      clientSecret: client_secret,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toBe("{}");
    expect(await second.text()).toBe("{}");
  });

  test("client auth failure writes an audit log entry", async () => {
    const { client_id } = await registerConfidentialClient();
    const token = mintAccessToken(client_id);

    const auditPath = path.join(env.LOG_DIR, "audit.log");
    let auditOffset = 0;
    try {
      auditOffset = fs.statSync(auditPath).size;
    } catch {
      // file may not exist yet
    }

    const r = await revoke({
      token,
      clientId: client_id,
      clientSecret: "wrong-secret",
    });
    expect(r.status).toBe(401);

    const rows = readAuditRows(auditPath, auditOffset);
    const hit = rows.find(
        (row) =>
          row &&
          row.event === "auth_failure" &&
          row.scope === "/oauth/revoke" &&
          row.result === "deny",
      );
    expect(hit).toBeDefined();
    expect(String(hit?.detail || "")).not.toContain(client_id);
  });

  test("revoke audit uses deterministic client fingerprint instead of raw client id", async () => {
    const { client_id, client_secret } = await registerConfidentialClient();
    const tokenA = mintAccessToken(client_id);
    const tokenB = mintAccessToken(client_id);

    const auditPath = path.join(env.LOG_DIR, "audit.log");
    let auditOffset = 0;
    try {
      auditOffset = fs.statSync(auditPath).size;
    } catch {
      // file may not exist yet
    }

    const ok = await revoke({
      token: tokenA,
      clientId: client_id,
      clientSecret: client_secret,
    });
    const bad = await revoke({
      token: tokenB,
      clientId: client_id,
      clientSecret: "wrong-secret",
    });
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(401);

    const rows = readAuditRows(auditPath, auditOffset).filter(
      (row) =>
        (row.event === "oauth_revoke" || row.event === "auth_failure") &&
        String(row.scope || "/oauth/revoke") === "/oauth/revoke",
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(String(row.detail || "")).not.toContain(client_id);
    }

    const fingerprints = rows
      .map((row) => {
        const m = String(row.detail || "").match(/client_fp=([0-9a-f]{16})/);
        return m?.[1] || "";
      })
      .filter(Boolean);
    expect(fingerprints.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fingerprints).size).toBe(1);
  });
});
