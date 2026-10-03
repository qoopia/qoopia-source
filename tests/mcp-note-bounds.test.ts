/** F-255: free-form MCP write fields are bounded, and note_list is a preview list. */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {registerTools} from '../src/mcp/tools.ts';
import type {AuthContext} from '../src/auth/middleware.ts';

let client: Client, server: McpServer;
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({name: 'Note bounds', slug: 'note-bounds'});
  const agent = createAgent({name: 'bounds-writer', workspaceSlug: ws.slug});
  const auth: AuthContext = {agent_id: agent.id, agent_name: 'bounds-writer', workspace_id: ws.id, type: 'standard', source: 'api-key', tool_profile: 'full'};
  server = new McpServer({name: 'bounds', version: '1'}); client = new Client({name: 'bounds-client', version: '1'});
  registerTools(server, () => auth, 'full', {agentToolProfile: 'full'});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
});
afterAll(async () => { await client.close(); await server.close(); });
const call = (name: string, args: Record<string, unknown>) => client.callTool({name, arguments: args});
const body = (r: Awaited<ReturnType<typeof call>>) => JSON.parse((r.content as {text: string}[])[0]!.text);
const tags = (n: number) => Array.from({length: n}, (_, i) => 't' + i);

test('metadata, tags and note ids are bounded at the MCP boundary', async () => {
  const blob = {blob: 'x'.repeat(17_000)};
  for (const extra of [{metadata: blob}, {tags: tags(51)}, {tags: ['x'.repeat(101)]}, {session_id: 's'.repeat(129)}, {project_id: 'p'.repeat(129)}])
    expect([extra, (await call('note_create', {text: 'bounded', ...extra})).isError]).toEqual([extra, true]);
  expect((await call('note_get', {id: 'n'.repeat(129)})).isError).toBe(true);
  expect((await call('note_update', {id: 'n', metadata_replace: blob})).isError).toBe(true);
  expect((await call('note_list', {tags: tags(51)})).isError).toBe(true);
  expect((await call('session_save', {session_id: 'bounds', role: 'user', content: 'x', metadata: blob})).isError).toBe(true);
  expect((await call('agent_session_create', {topic: 'bounds', metadata: blob})).isError).toBe(true);
  const fits = await call('note_create', {text: 'fits', metadata: {blob: 'x'.repeat(15_000)}, tags: tags(50), session_id: 's'.repeat(128)});
  expect(fits.isError).not.toBe(true);
});

test('note_list returns a 500-char preview, not the full body, of a long note', async () => {
  const long = body(await call('note_create', {text: 'L'.repeat(99_000), type: 'memory'})).id;
  const short = body(await call('note_create', {text: 'short body', type: 'memory'})).id;
  const items = body(await call('note_list', {type: 'memory'})).items as Record<string, unknown>[];
  const longItem = items.find(i => i.id === long)!, shortItem = items.find(i => i.id === short)!;
  expect('text' in longItem).toBe(false);
  expect(longItem.text_preview).toBe('L'.repeat(500));
  expect(longItem.text_preview_only).toBe(true);
  expect(shortItem).toMatchObject({text: 'short body', text_preview: 'short body', text_preview_only: false});
  expect(body(await call('note_get', {id: long})).text.length).toBe(99_000);
});
