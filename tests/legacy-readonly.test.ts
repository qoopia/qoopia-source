import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "qoopia-legacy-readonly-"));
const dataDir = join(tmp, "data");
const logDir = join(tmp, "logs");
const backupDir = join(tmp, "backups");

type Seed = {
  apiKey: string;
  oauthToken: string;
  clientId: string;
  ticketId: string;
};

let seed: Seed;

function runBun(script: string, role: "canonical" | "legacy-readonly") {
  return Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      // This subprocess exercises the SQLite role invariant with an ephemeral
      // port, not the sealed production startup contract (covered separately
      // by runtime-config tests).
      NODE_ENV: "test",
      QOOPIA_SERVER_ROLE: role,
      QOOPIA_DATA_DIR: dataDir,
      QOOPIA_LOG_DIR: logDir,
      QOOPIA_BACKUP_DIR: backupDir,
      QOOPIA_PORT: "0",
      QOOPIA_LOG_LEVEL: "error",
      QOOPIA_ADMIN_SECRET: "legacy-readonly-test-admin-secret",
      QOOPIA_AUTO_EMBED: "false",
      QOOPIA_RECALL_MODE: "fts5",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function markerJson<T>(stdout: Uint8Array, marker: string): T {
  const line = new TextDecoder()
    .decode(stdout)
    .split("\n")
    .find((entry) => entry.startsWith(marker));
  if (!line) throw new Error(`child output did not include ${marker}`);
  return JSON.parse(line.slice(marker.length)) as T;
}

beforeAll(() => {
  const init = runBun(
    String.raw`
      import { runMigrations } from "./src/db/migrate.ts";
      import { closeDb, db } from "./src/db/connection.ts";
      import { createWorkspace } from "./src/admin/workspaces.ts";
      import { createAgent } from "./src/admin/agents.ts";
      import { createNote } from "./src/services/notes.ts";
      import { sha256Hex } from "./src/auth/api-keys.ts";
      import {
        approveConsentTicket,
        createConsentTicket,
        registerClient,
      } from "./src/auth/oauth.ts";

      runMigrations();
      const workspace = createWorkspace({ name: "Legacy Readonly", slug: "legacy-readonly" });
      const agent = createAgent({
        name: "legacy-reader",
        workspaceSlug: workspace.slug,
        type: "steward",
      });
      createNote({
        workspace_id: workspace.id,
        agent_id: agent.id,
        text: "legacy readonly recall marker",
        type: "knowledge",
      });
      const client = registerClient(
        {
          client_name: "Legacy readonly test",
          redirect_uris: ["http://127.0.0.1/callback"],
        },
        {
          agent_id: agent.id,
          agent_name: agent.name,
          workspace_id: workspace.id,
          type: "steward",
          source: "api-key",
          tool_profile: "full",
        },
      );
      const ticket = createConsentTicket({
        clientId: client.client_id,
        workspaceId: workspace.id,
        redirectUri: "http://127.0.0.1/callback",
        codeChallenge: "A".repeat(43),
        codeChallengeMethod: "S256",
        scope: "mcp:read",
        state: "state",
      });
      if (!approveConsentTicket(ticket.id, agent.id)) throw new Error("seed approval failed");
      const oauthToken = "qa_" + "R".repeat(43);
      db.query(
        "INSERT INTO oauth_tokens " +
          "(token_hash, client_id, agent_id, workspace_id, token_type, " +
          "granted_scope, expires_at, revoked, created_at) " +
          "VALUES (?, ?, ?, ?, 'access', 'mcp:read', ?, 0, ?)",
      ).run(
        sha256Hex(oauthToken),
        client.client_id,
        agent.id,
        workspace.id,
        "2099-01-01T00:00:00Z",
        new Date().toISOString(),
      );
      console.log("SEED=" + JSON.stringify({
        apiKey: agent.api_key,
        oauthToken,
        clientId: client.client_id,
        ticketId: ticket.id,
      }));
      closeDb();
    `,
    "canonical",
  );
  expect(init.exitCode).toBe(0);
  seed = markerJson<Seed>(init.stdout, "SEED=");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("legacy-readonly DB invariant", () => {
  test("allowed HTTP/HEAD and MCP reads leave the database logically unchanged", () => {
    const probe = runBun(
      String.raw`
        import { createHash } from "node:crypto";
        import { db, closeDb, DB_READ_ONLY } from "./src/db/connection.ts";
        import { startHttpServer } from "./src/http.ts";

        const apiKey = ${JSON.stringify(seed.apiKey)};
        const oauthToken = ${JSON.stringify(seed.oauthToken)};
        const clientId = ${JSON.stringify(seed.clientId)};
        const ticketId = ${JSON.stringify(seed.ticketId)};

        function logicalDigest() {
          const tables = db.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          ).all();
          const snapshot = [];
          for (const { name } of tables) {
            const quoted = '"' + String(name).replaceAll('"', '""') + '"';
            const rows = db.query("SELECT * FROM " + quoted).all();
            snapshot.push([name, rows]);
          }
          return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
        }

        const before = logicalDigest();
        const queryOnly = db.query("PRAGMA query_only").get().query_only;
        let directWriteBlocked = false;
        try {
          db.query("UPDATE agents SET last_seen = 'forbidden'").run();
        } catch (error) {
          directWriteBlocked = /read.?only|readonly|attempt to write/i.test(String(error));
        }

        const server = startHttpServer();
        await new Promise((resolve) => {
          if (server.listening) resolve();
          else server.once("listening", resolve);
        });
        const address = server.address();
        const baseUrl = "http://127.0.0.1:" + address.port;

        const health = await fetch(baseUrl + "/health");
        const dashboardHead = await fetch(baseUrl + "/dashboard", { method: "HEAD" });
        const dashboardRead = await fetch(baseUrl + "/api/dashboard/agents", {
          headers: { authorization: "Bearer " + apiKey },
        });
        const mcp = await fetch(baseUrl + "/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer " + apiKey,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "recall",
              arguments: { query: "legacy readonly recall marker", limit: 5 },
            },
          }),
        });
        const mcpBody = await mcp.text();
        const oauthMcp = await fetch(baseUrl + "/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer " + oauthToken,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "recall",
              arguments: { query: "legacy readonly recall marker", limit: 5 },
            },
          }),
        });

        const challenge = "A".repeat(43);
        const authorize = new URL(baseUrl + "/oauth/authorize");
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("client_id", clientId);
        authorize.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
        authorize.searchParams.set("code_challenge", challenge);
        authorize.searchParams.set("code_challenge_method", "S256");
        const oauthAuthorize = await fetch(authorize, { redirect: "manual" });
        const oauthFinalize = await fetch(
          baseUrl + "/oauth/authorize/finalize?ticket=" + encodeURIComponent(ticketId),
          { redirect: "manual" },
        );
        const oauthConsent = await fetch(
          baseUrl + "/api/dashboard/oauth-consent?ticket=" + encodeURIComponent(ticketId),
          { redirect: "manual" },
        );

        const after = logicalDigest();
        await new Promise((resolve) => server.close(resolve));
        closeDb();

        console.log("PROBE=" + JSON.stringify({
          dbReadOnly: DB_READ_ONLY,
          queryOnly,
          directWriteBlocked,
          health: health.status,
          dashboardHead: dashboardHead.status,
          dashboardRead: dashboardRead.status,
          mcp: mcp.status,
          mcpReturnedMarker: mcpBody.includes("legacy readonly recall marker"),
          oauthMcp: oauthMcp.status,
          oauthAuthorize: oauthAuthorize.status,
          oauthFinalize: oauthFinalize.status,
          oauthConsent: oauthConsent.status,
          unchanged: before === after,
        }));
      `,
      "legacy-readonly",
    );

    if (probe.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(probe.stderr));
    }
    const result = markerJson<Record<string, unknown>>(probe.stdout, "PROBE=");
    expect(result).toEqual({
      dbReadOnly: true,
      queryOnly: 1,
      directWriteBlocked: true,
      health: 200,
      dashboardHead: 200,
      dashboardRead: 200,
      mcp: 200,
      mcpReturnedMarker: true,
      oauthMcp: 200,
      oauthAuthorize: 503,
      oauthFinalize: 503,
      oauthConsent: 503,
      unchanged: true,
    });
  });
});
