/**
 * End-to-end smoke test: boot the HTTP server on an ephemeral port, create a
 * workspace + agent in-process, then exercise the public endpoints (/health,
 * /api/v1/notes via Bearer auth) and confirm a saved note can be recalled.
 *
 * The server listens on QOOPIA_PORT=0 (set by tests/setup.ts) so the OS
 * assigns a free port and parallel test runs never collide.
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
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { createNote } from "../src/services/notes.ts";
import { PRODUCT_VERSION } from "../src/utils/product-version.ts";

let server: Server;
let baseUrl = "";
let API_KEY = "";
let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Smoke Test", slug: "smoke-test" });
  WORKSPACE_ID = ws.id;
  const ag = createAgent({ name: "smoke-tester", workspaceSlug: ws.slug });
  AGENT_ID = ag.id;
  API_KEY = ag.api_key;

  server = startHttpServer();
  // Wait for the listener to actually bind.
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  // Only stop the HTTP listener — leave the SQLite singleton open. Other test
  // files that ran first (notes, auth) still hold module references to it via
  // their own beforeAll(), and Bun's test runner spawns one process per glob
  // match, so closing here would break sibling files when ordering changes.
  // setup.ts cleans the temp dir on process exit.
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("smoke: HTTP boot", () => {
  test("/health returns 200 ok", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      status: string;
      version: string;
      release_sha: string | null;
      schema_version: number;
      feature_flags: Record<string, boolean>;
      build_commit: string | null;
    };
    expect(body.status).toBe("ok");
    expect(body.version).toBe(PRODUCT_VERSION);
    expect(body.schema_version).toBeGreaterThan(0);
    expect(body).toHaveProperty("build_commit");
    if (body.build_commit !== null) {
      expect(body.build_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(body.build_commit).toBe(body.release_sha);
    }
    expect(Object.values(body.feature_flags).length).toBeGreaterThan(0);
    expect(Object.values(body.feature_flags).every((value) => typeof value === "boolean")).toBe(true);
  });

  test("/ready returns 200 ready with runtime metadata on a fully migrated database", async () => {
    const r = await fetch(`${baseUrl}/ready`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      status: string;
      version: string;
      release_sha: string | null;
      schema_version: number;
      feature_flags: Record<string, boolean>;
      server_role: string;
      instance_id: string;
      writes_enabled: boolean;
    };
    expect(body.status).toBe("ready");
    expect(body.version).toBe(PRODUCT_VERSION);
    expect(body).toHaveProperty("release_sha");
    expect(body.schema_version).toBeGreaterThan(0);
    expect(Object.values(body.feature_flags).length).toBeGreaterThan(0);
    expect(Object.values(body.feature_flags).every((value) => typeof value === "boolean")).toBe(true);
    expect(body.server_role).toBe("canonical");
    expect(body.instance_id).toBeTruthy();
    expect(body.writes_enabled).toBe(true);
  });

  test("root endpoint identifies the current product runtime", async () => {
    const r = await fetch(`${baseUrl}/`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(`Qoopia ${PRODUCT_VERSION} MCP server`);
    expect(body).not.toContain("Qoopia V3.0");
  });

  test("/dashboard accepts query params for OAuth consent next bounce", async () => {
    const r = await fetch(`${baseUrl}/dashboard?next=%2Fapi%2Fdashboard%2Foauth-consent%3Fticket%3Dqct_test`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Qoopia V1");
    expect(html).toContain("consumeSafeNext");
  });

  test("OAuth authorization-server metadata also works for protected resource path", async () => {
    const r = await fetch(baseUrl + "/.well-known/oauth-authorization-server/mcp");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { issuer: string; authorization_endpoint: string };
    expect(body.authorization_endpoint).toContain("/oauth/authorize");
  });

  test("dashboard API requires Bearer auth", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agents`);
    expect(r.status).toBe(401);
  });

  test("dashboard API with valid agent key returns its workspace", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{ id: string; workspace_id: string; name: string }>;
      total: number;
    };
    const found = body.items.find((a) => a.id === AGENT_ID);
    expect(found).toBeDefined();
    expect(found?.workspace_id).toBe(WORKSPACE_ID);
  });
});

describe("smoke: save → recall round-trip", () => {
  test("a note created in-process is visible via dashboard notes endpoint", async () => {
    const created = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "smoke memory: boot succeeded",
      type: "memory",
    });

    const r = await fetch(
      `${baseUrl}/api/dashboard/agents/${AGENT_ID}/notes?type=memory&limit=10`,
      { headers: { authorization: `Bearer ${API_KEY}` } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{ id: string; text: string; type: string }>;
    };
    const found = body.items.find((n) => n.id === created.id);
    expect(found).toBeDefined();
    expect(found?.text).toBe("smoke memory: boot succeeded");
    expect(found?.type).toBe("memory");
  });
});
