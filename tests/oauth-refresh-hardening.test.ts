import { beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";
import {
  createAuthorizationCode,
  exchangeCodeForTokens,
  refreshTokens,
  registerClient,
} from "../src/auth/oauth.ts";

let workspaceA = "";
let workspaceB = "";
let activeAgent = "";
let inactiveAgent = "";
let exchangeActiveAgent = "";
let exchangeInactiveAgent = "";
let exchangeDriftAgent = "";

beforeAll(() => {
  runMigrations();
  const wsA = createWorkspace({ name: "Refresh Hardening A", slug: "refresh-hardening-a" });
  const wsB = createWorkspace({ name: "Refresh Hardening B", slug: "refresh-hardening-b" });
  workspaceA = wsA.id;
  workspaceB = wsB.id;
  activeAgent = createAgent({
    name: "refresh-active-agent",
    workspaceSlug: wsA.slug,
    type: "steward",
  }).id;
  inactiveAgent = createAgent({
    name: "refresh-inactive-agent",
    workspaceSlug: wsA.slug,
    type: "standard",
  }).id;
  exchangeActiveAgent = createAgent({
    name: "exchange-active-agent",
    workspaceSlug: wsA.slug,
    type: "standard",
  }).id;
  exchangeInactiveAgent = createAgent({
    name: "exchange-inactive-agent",
    workspaceSlug: wsA.slug,
    type: "standard",
  }).id;
  exchangeDriftAgent = createAgent({
    name: "exchange-drift-agent",
    workspaceSlug: wsA.slug,
    type: "standard",
  }).id;
});

function mintRefresh(options: {
  agentId: string;
  clientWorkspace?: string;
  tokenWorkspace?: string;
  suffix: string;
}): { clientId: string; raw: string } {
  const client = registerClient(
    {
      client_name: `refresh-hardening-${options.suffix}`,
      redirect_uris: ["https://example.com/oauth/callback"],
      token_endpoint_auth_method: "none",
    },
    {
      agent_id: options.agentId,
      agent_name: "refresh-test-agent",
      workspace_id: workspaceA,
      type: "steward",
      source: "api-key",
    },
  );
  if (options.clientWorkspace) {
    db.prepare(`UPDATE oauth_clients SET workspace_id = ? WHERE id = ?`).run(
      options.clientWorkspace,
      client.client_id,
    );
  }
  const raw = `qr_test_refresh_${options.suffix}`;
  db.prepare(
    `INSERT INTO oauth_tokens
       (token_hash, client_id, agent_id, workspace_id, token_type,
        granted_scope, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, 'refresh', 'mcp:read', ?, 0, ?)`,
  ).run(
    sha256Hex(raw),
    client.client_id,
    options.agentId,
    options.tokenWorkspace ?? workspaceA,
    new Date(Date.now() + 60_000).toISOString(),
    new Date().toISOString(),
  );
  return { clientId: client.client_id, raw };
}

function mintCode(options: {
  agentId: string;
  clientWorkspace?: string;
  codeWorkspace?: string;
  suffix: string;
}): { clientId: string; code: string; verifier: string } {
  const client = registerClient(
    {
      client_name: `exchange-hardening-${options.suffix}`,
      redirect_uris: ["https://example.com/oauth/callback"],
      token_endpoint_auth_method: "none",
    },
    {
      agent_id: options.agentId,
      agent_name: "exchange-test-agent",
      workspace_id: workspaceA,
      type: "steward",
      source: "api-key",
    },
  );
  if (options.clientWorkspace) {
    db.prepare(`UPDATE oauth_clients SET workspace_id = ? WHERE id = ?`).run(
      options.clientWorkspace,
      client.client_id,
    );
  }
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const code = createAuthorizationCode({
    clientId: client.client_id,
    agentId: options.agentId,
    workspaceId: options.codeWorkspace ?? workspaceA,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    redirectUri: "https://example.com/oauth/callback",
    grantedScope: "mcp:read",
  });
  return { clientId: client.client_id, code, verifier };
}

function exchange(seeded: { clientId: string; code: string; verifier: string }) {
  return exchangeCodeForTokens({
    clientId: seeded.clientId,
    code: seeded.code,
    codeVerifier: seeded.verifier,
    redirectUri: "https://example.com/oauth/callback",
  });
}

describe("OAuth refresh rotation active/workspace predicates", () => {
  test("an active agent with aligned client/token workspace rotates once", () => {
    const seeded = mintRefresh({ agentId: activeAgent, suffix: "happy" });
    const rotated = refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    });
    expect(rotated.access).toStartWith("qa_");
    expect(rotated.refresh).toStartWith("qr_");
    const original = db.prepare(
      `SELECT revoked FROM oauth_tokens WHERE token_hash = ?`,
    ).get(sha256Hex(seeded.raw)) as { revoked: number };
    expect(original.revoked).toBe(1);
  });

  test("a deactivated agent cannot rotate an otherwise valid refresh token", () => {
    const seeded = mintRefresh({ agentId: inactiveAgent, suffix: "inactive" });
    db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(inactiveAgent);
    expect(() => refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    })).toThrow("invalid_grant");
    const rows = db.prepare(
      `SELECT revoked FROM oauth_tokens WHERE client_id = ?`,
    ).all(seeded.clientId) as Array<{ revoked: number }>;
    expect(rows).toEqual([{ revoked: 0 }]);
  });

  test("client/token workspace drift fails atomically without minting replacements", () => {
    const seeded = mintRefresh({
      agentId: activeAgent,
      clientWorkspace: workspaceB,
      suffix: "workspace-drift",
    });
    expect(() => refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    })).toThrow("invalid_grant");
    const rows = db.prepare(
      `SELECT token_type, revoked FROM oauth_tokens WHERE client_id = ?`,
    ).all(seeded.clientId) as Array<{ token_type: string; revoked: number }>;
    expect(rows).toEqual([{ token_type: "refresh", revoked: 0 }]);
  });

  test("replaying a rotated refresh token is rejected without revoking its descendant", () => {
    const seeded = mintRefresh({ agentId: activeAgent, suffix: "explicit-replay" });
    const firstRotation = refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    });

    expect(() => refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    })).toThrow("invalid_grant");

    const secondRotation = refreshTokens({
      refreshToken: firstRotation.refresh,
      clientId: seeded.clientId,
    });
    expect(secondRotation.access).toStartWith("qa_");
    expect(secondRotation.refresh).toStartWith("qr_");
  });
});

describe("OAuth code exchange active/workspace predicates", () => {
  test("an active agent with aligned client/code workspace can exchange", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "happy" });
    const tokens = exchange(seeded);
    expect(tokens.access).toStartWith("qa_");
    expect(tokens.refresh).toStartWith("qr_");
  });

  test("a deactivated agent cannot exchange a previously issued code", () => {
    const seeded = mintCode({ agentId: exchangeInactiveAgent, suffix: "inactive" });
    db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(exchangeInactiveAgent);

    expect(() => exchange(seeded)).toThrow("invalid_grant");
    const rows = db.prepare(
      `SELECT token_type, revoked FROM oauth_tokens WHERE client_id = ?`,
    ).all(seeded.clientId) as Array<{ token_type: string; revoked: number }>;
    expect(rows).toEqual([{ token_type: "code", revoked: 0 }]);
  });

  test("agent/code workspace drift rejects exchange atomically", () => {
    const seeded = mintCode({ agentId: exchangeDriftAgent, suffix: "agent-drift" });
    db.prepare(`UPDATE agents SET workspace_id = ? WHERE id = ?`).run(
      workspaceB,
      exchangeDriftAgent,
    );

    expect(() => exchange(seeded)).toThrow("invalid_grant");
    const rows = db.prepare(
      `SELECT token_type, revoked FROM oauth_tokens WHERE client_id = ?`,
    ).all(seeded.clientId) as Array<{ token_type: string; revoked: number }>;
    expect(rows).toEqual([{ token_type: "code", revoked: 0 }]);
  });

  test("client/code workspace drift rejects exchange atomically", () => {
    const seeded = mintCode({
      agentId: exchangeActiveAgent,
      clientWorkspace: workspaceB,
      suffix: "client-drift",
    });

    expect(() => exchange(seeded)).toThrow("invalid_grant");
    const rows = db.prepare(
      `SELECT token_type, revoked FROM oauth_tokens WHERE client_id = ?`,
    ).all(seeded.clientId) as Array<{ token_type: string; revoked: number }>;
    expect(rows).toEqual([{ token_type: "code", revoked: 0 }]);
  });
});
