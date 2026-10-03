/** F-259: MCP tool failures from src/mcp read '<CODE>: <message>', and no tool silently drops an unknown argument. */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {createMcpServer} from '../src/mcp/server.ts';
import {authorityOperations} from '../src/api/authority.ts';
import {BRIDGE_TOOL_NAMES} from '../src/bridges/api.ts';
import type {AuthContext} from '../src/auth/middleware.ts';

let client: Client, server: McpServer;
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({name: 'Error shape', slug: 'mcp-error-shape'});
  const owner = createAgent({name: 'error-shape-owner', workspaceSlug: ws.slug, type: 'owner'});
  const auth: AuthContext = {agent_id: owner.id, agent_name: 'error-shape-owner', workspace_id: ws.id, type: 'owner', source: 'api-key', tool_profile: 'full'};
  server = createMcpServer(() => auth, 'full', {isSteward: true, agentToolProfile: 'full'});
  client = new Client({name: 'error-shape', version: '1'});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
});
afterAll(async () => { await client.close(); await server.close(); });
const text = (r: Awaited<ReturnType<Client['callTool']>>) => [r.isError, (r.content as {text: string}[])[0]!.text] as const;

test('an unknown argument is refused as INVALID_INPUT by every tool registered from src/mcp', async () => {
  // Authority and bridge operations keep their own JSON error shape (outside src/mcp).
  const elsewhere = new Set([...authorityOperations.map(op => op.name), ...BRIDGE_TOOL_NAMES]);
  const {tools} = await client.listTools();
  expect(tools.some(t => t.name === 'memory_policy_list')).toBe(true);
  const wrong: unknown[] = [];
  for (const tool of tools.filter(t => !elsewhere.has(t.name))) {
    const [isError, message] = text(await client.callTool({name: tool.name, arguments: {zz_unknown: 1}}));
    if (!isError || !message.startsWith('INVALID_INPUT: ')) wrong.push([tool.name, isError, message.slice(0, 120)]);
  }
  expect(wrong).toEqual([]);
});

test('a wrong type and an unknown tool carry a code; the detail is bounded', async () => {
  expect(text(await client.callTool({name: 'note_create', arguments: {text: 5}}))).toEqual([true, expect.stringMatching(/^INVALID_INPUT: .*text/)]);
  const [isError, message] = text(await client.callTool({name: 'x'.repeat(5000), arguments: {}}));
  expect([isError, message.startsWith('NOT_FOUND: '), message.length <= 600]).toEqual([true, true, true]);
});
