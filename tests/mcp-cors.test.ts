/**
 * Regression: browser-hosted Claude.ai must be able to read the OAuth
 * challenge from /mcp 401. Without Access-Control-Expose-Headers,
 * fetch hides WWW-Authenticate and Claude.ai reports the MCP server as
 * not responding instead of starting OAuth discovery.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  runMigrations();
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

describe("Claude.ai MCP OAuth discovery CORS", () => {
  test("unauthorized /mcp exposes WWW-Authenticate to https://claude.ai", async () => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: "https://claude.ai",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claude-ai", version: "test" },
        },
      }),
    });

    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(r.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
    expect(r.headers.get("www-authenticate") || "").toContain("resource_metadata=");
  });

  test("preflight allows MCP protocol version header from https://claude.ai", async () => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,mcp-protocol-version",
      },
    });

    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(r.headers.get("access-control-allow-methods") || "").toContain("POST");
    expect(r.headers.get("access-control-allow-headers") || "").toContain("mcp-protocol-version");
  });
});
