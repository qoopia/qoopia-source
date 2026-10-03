import { beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";
import {
  createAuthorizationCode,
  exchangeCodeForTokens,
  findActiveToken,
  refreshTokens,
  registerClient,
} from "../src/auth/oauth.ts";
import { handleToken } from "../src/http/oauth-routes.ts";

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

/** Run `fn` past the 30s window in which a client's own duplicate request is tolerated. */
function afterGraceWindow(fn: () => void) {
  setSystemTime(new Date(Date.now() + 31_000));
  try {
    fn();
  } finally {
    setSystemTime();
  }
}

/** Drive the /oauth/token handler directly with a form body. */
function callToken(form: Record<string, string>): { status: number; body: Record<string, unknown> } {
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { payload = chunk ?? ""; },
  } as unknown as ServerResponse;
  const req = { headers: { "content-type": "application/x-www-form-urlencoded" } } as unknown as IncomingMessage;
  handleToken(req, Buffer.from(new URLSearchParams(form).toString()), res);
  return { status, body: JSON.parse(payload) as Record<string, unknown> };
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

  test("replaying a rotated refresh token revokes every live token of that client and agent (F-128)", () => {
    const seeded = mintRefresh({ agentId: activeAgent, suffix: "explicit-replay" });
    const bystander = mintRefresh({ agentId: activeAgent, suffix: "explicit-replay-bystander" });
    const firstRotation = refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    });

    afterGraceWindow(() => expect(() => refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    })).toThrow("invalid_grant"));

    // The revocation is committed even though the request itself failed.
    expect(findActiveToken(firstRotation.access)).toBeNull();
    expect(findActiveToken(firstRotation.refresh)).toBeNull();
    expect(() => refreshTokens({
      refreshToken: firstRotation.refresh,
      clientId: seeded.clientId,
    })).toThrow("invalid_grant");
    // Another client of the same agent is a different family.
    expect(findActiveToken(bystander.raw)).not.toBeNull();
  });

  test("a duplicate refresh inside the grace window is refused without revoking the descendant", () => {
    const seeded = mintRefresh({ agentId: activeAgent, suffix: "grace-replay" });
    const firstRotation = refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    });

    expect(() => refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    })).toThrow("invalid_grant");

    expect(findActiveToken(firstRotation.access)).not.toBeNull();
    const secondRotation = refreshTokens({
      refreshToken: firstRotation.refresh,
      clientId: seeded.clientId,
    });
    expect(secondRotation.access).toStartWith("qa_");
  });

  test("a rotated refresh token presented by another client revokes nothing", () => {
    const seeded = mintRefresh({ agentId: activeAgent, suffix: "foreign-replay" });
    const other = mintRefresh({ agentId: activeAgent, suffix: "foreign-replay-other" });
    const firstRotation = refreshTokens({
      refreshToken: seeded.raw,
      clientId: seeded.clientId,
    });

    afterGraceWindow(() => expect(() => refreshTokens({
      refreshToken: seeded.raw,
      clientId: other.clientId,
    })).toThrow("invalid_grant"));

    expect(findActiveToken(firstRotation.refresh)).not.toBeNull();
    expect(findActiveToken(other.raw)).not.toBeNull();
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

describe("F-129: replaying an authorization code revokes what it issued", () => {
  test("a second exchange with the right verifier revokes the tokens from the first", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "code-replay" });
    const tokens = exchange(seeded);

    afterGraceWindow(() => expect(() => exchange(seeded)).toThrow("invalid_grant"));

    expect(findActiveToken(tokens.access)).toBeNull();
    expect(findActiveToken(tokens.refresh)).toBeNull();
  });

  test("a leaked code without its verifier cannot revoke anything", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "code-replay-no-verifier" });
    const tokens = exchange(seeded);

    afterGraceWindow(() => expect(() => exchange({
      ...seeded,
      verifier: crypto.randomBytes(32).toString("base64url"),
    })).toThrow("invalid_grant"));

    expect(findActiveToken(tokens.access)).not.toBeNull();
    expect(findActiveToken(tokens.refresh)).not.toBeNull();
  });

  test("a duplicate exchange inside the grace window does not revoke", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "code-replay-grace" });
    const tokens = exchange(seeded);

    expect(() => exchange(seeded)).toThrow("invalid_grant");

    expect(findActiveToken(tokens.access)).not.toBeNull();
  });
});

describe("F-190: token endpoint error hygiene and S256-only PKCE", () => {
  test("an unexpected internal error is a 500 server_error, never its raw message", () => {
    const spy = spyOn(db, "transaction").mockImplementation((() => () => {
      throw new Error("database is locked");
    }) as unknown as typeof db.transaction);
    try {
      const out = callToken({
        grant_type: "authorization_code",
        code: "qc_unused",
        code_verifier: "v".repeat(43),
        redirect_uri: "https://example.com/oauth/callback",
        client_id: "qc_unknown_client",
      });
      expect(out.status).toBe(500);
      expect(out.body).toEqual({ error: "server_error" });
    } finally {
      spy.mockRestore();
    }
  });

  test("OAuth error codes keep their 400 response", () => {
    const out = callToken({
      grant_type: "refresh_token",
      refresh_token: "qr_never_issued",
      client_id: "qc_unknown_client",
    });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "invalid_grant" });
  });

  test("a code row stored with the plain PKCE method is rejected", () => {
    const client = registerClient(
      { client_name: "plain-pkce", redirect_uris: ["https://example.com/oauth/callback"], token_endpoint_auth_method: "none" },
      { agent_id: exchangeActiveAgent, agent_name: "plain-pkce", workspace_id: workspaceA, type: "steward", source: "api-key" },
    );
    const verifier = crypto.randomBytes(32).toString("base64url");
    const code = createAuthorizationCode({
      clientId: client.client_id,
      agentId: exchangeActiveAgent,
      workspaceId: workspaceA,
      codeChallenge: verifier,
      codeChallengeMethod: "plain",
      redirectUri: "https://example.com/oauth/callback",
      grantedScope: "mcp:read",
    });
    expect(() => exchange({ clientId: client.client_id, code, verifier })).toThrow("invalid_grant");
  });
});

describe("F-132: OAuth protocol negatives", () => {
  const REDIRECT = "https://example.com/oauth/callback";
  const PAST = "2000-01-01T00:00:00Z";

  test("the token endpoint matches redirect_uri exactly, and a mismatch does not burn the code", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "redirect-exact" });
    for (const redirectUri of [
      REDIRECT + "/",
      "https://example.com/OAuth/callback",
      REDIRECT + "?x=1",
      REDIRECT + "#f",
      "https://user@example.com/oauth/callback",
      "https://example.com:8443/oauth/callback",
      "http://example.com/oauth/callback",
    ]) {
      expect(() => exchangeCodeForTokens({
        clientId: seeded.clientId,
        code: seeded.code,
        codeVerifier: seeded.verifier,
        redirectUri,
      })).toThrow("invalid_grant");
    }
    expect(exchange(seeded).access).toStartWith("qa_");
  });

  test("a malformed code_verifier is invalid_request and a wrong one invalid_grant", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "pkce-verifier" });
    for (const verifier of ["a".repeat(42), "a".repeat(129), "a".repeat(42) + "!"]) {
      expect(() => exchange({ ...seeded, verifier })).toThrow("invalid_request");
    }
    expect(() => exchange({ ...seeded, verifier: "b".repeat(43) })).toThrow("invalid_grant");
    expect(exchange(seeded).access).toStartWith("qa_");
  });

  test("a code is bound to the client it was issued to", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "client-bound" });
    const other = mintCode({ agentId: exchangeActiveAgent, suffix: "client-bound-other" });
    expect(() => exchange({ ...seeded, clientId: other.clientId })).toThrow("invalid_grant");
    expect(exchange(seeded).access).toStartWith("qa_");
  });

  test("expired codes, access tokens and refresh tokens are rejected", () => {
    const stale = mintCode({ agentId: exchangeActiveAgent, suffix: "expired-code" });
    db.prepare(`UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?`).run(PAST, sha256Hex(stale.code));
    expect(() => exchange(stale)).toThrow("invalid_grant");

    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "expired-tokens" });
    const tokens = exchange(seeded);
    db.prepare(`UPDATE oauth_tokens SET expires_at = ? WHERE token_hash IN (?, ?)`)
      .run(PAST, sha256Hex(tokens.access), sha256Hex(tokens.refresh));
    expect(findActiveToken(tokens.access)).toBeNull();
    expect(() => refreshTokens({ refreshToken: tokens.refresh, clientId: seeded.clientId })).toThrow("invalid_grant");
  });

  test("a refresh cannot widen the granted scope or move the audience", () => {
    const seeded = mintCode({ agentId: exchangeActiveAgent, suffix: "refresh-narrow" });
    const tokens = exchange(seeded);
    const widened = callToken({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
      client_id: seeded.clientId,
      scope: "mcp:read mcp:write mcp:admin",
    });
    expect(widened.status).toBe(200);
    expect(widened.body.scope).toBe("mcp:read");
    const moved = callToken({
      grant_type: "refresh_token",
      refresh_token: String(widened.body.refresh_token),
      client_id: seeded.clientId,
      resource: "https://evil.example/mcp",
    });
    expect(moved).toEqual({ status: 400, body: { error: "invalid_target" } });
  });

  test("a confidential client must present its secret at the token endpoint", () => {
    const client = registerClient(
      { client_name: "confidential-negatives", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" },
      { agent_id: exchangeActiveAgent, agent_name: "confidential-negatives", workspace_id: workspaceA, type: "steward", source: "api-key" },
    );
    const verifier = crypto.randomBytes(32).toString("base64url");
    const code = createAuthorizationCode({
      clientId: client.client_id,
      agentId: exchangeActiveAgent,
      workspaceId: workspaceA,
      codeChallenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      redirectUri: REDIRECT,
      grantedScope: "mcp:read",
    });
    const grant = (clientSecret?: string) => exchangeCodeForTokens({
      clientId: client.client_id, code, codeVerifier: verifier, redirectUri: REDIRECT, clientSecret,
    });
    expect(() => grant()).toThrow("invalid_client");
    expect(() => grant("qcs_wrong")).toThrow("invalid_client");
    const tokens = grant(client.client_secret);
    for (const clientSecret of [undefined, "qcs_wrong"]) {
      expect(() => refreshTokens({ refreshToken: tokens.refresh, clientId: client.client_id, clientSecret }))
        .toThrow("invalid_client");
    }
  });
});
