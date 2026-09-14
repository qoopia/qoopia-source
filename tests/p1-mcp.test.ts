import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAuthorityTools } from "../src/api/authority.ts";
import { ownerFixture, completeContent } from "./helpers/p1-fixtures.ts";

test("T-05/T-22: real SDK MCP transport uses the same writer and refuses unknown input/current revoke", async () => {
  const { database: d, auth } = ownerFixture();
  const server = new McpServer({ name: "p1-fixture", version: "1" }), client = new Client({ name: "p1-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    registerAuthorityTools(server, () => auth, new Set(), d);
    await server.connect(serverTransport); await client.connect(clientTransport);
    const catalog = await client.listTools();
    expect(catalog.tools.some((t) => t.name === "skill_draft_revise")).toBe(true);
    const args = { slug: "mcp", content: completeContent, expected_revision: 0, idempotency_key: "mcp-create" };
    const first = await client.callTool({ name: "skill_draft_revise", arguments: args });
    expect(first.isError).not.toBe(true);
    const unknown = await client.callTool({ name: "skill_draft_revise", arguments: { ...args, workspace_id: "forged" } });
    expect(unknown.isError).toBe(true);
    const second = await client.callTool({ name: "skill_draft_revise", arguments: args });
    expect(second.content).toEqual(first.content);
    d.query("UPDATE agents SET active=0 WHERE id=?").run(auth.agent_id);
    const revoked = await client.callTool({ name: "skill_draft_revise", arguments: args });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).toContain("UNAUTHENTICATED");
  } finally { await client.close(); await server.close(); d.close(); }
});
