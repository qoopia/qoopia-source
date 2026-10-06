/** C6: /mcp speaks MCP 2026-07-28 (per-request envelope, no initialize) and keeps 2025-era clients (ChatGPT, Claude.ai) on the initialize handshake. */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {startHttpServer} from '../src/http.ts';
import {AUTOSAVE_INSTRUCTION} from '../src/services/memory-policy.ts';

let server: Server, base = '', key = '';
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({name: 'MCP eras', slug: 'mcp-protocol-eras'});
  key = createAgent({name: 'mcp-eras-agent', workspaceSlug: ws.slug}).api_key;
  server = startHttpServer(); if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });

/** One 2026-07-28 request: the `_meta` envelope plus the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. */
async function modern(method: string, params: Record<string, unknown> = {}, name?: string) {
  const r = await fetch(`${base}/mcp`, {method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name ? {'mcp-name': name} : {}),
  }, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params: {...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': {name: 'eras-test', version: '1'},
    'io.modelcontextprotocol/clientCapabilities': {},
  }}})});
  const text = await r.text();
  const payload = r.headers.get('content-type')?.startsWith('text/event-stream') ? text.split('\n').filter(l => l.startsWith('data:')).at(-1)!.slice(5) : text;
  return [r.status, JSON.parse(payload)] as const;
}

test('a 2025-11-25 client negotiates through initialize and lists the tools', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {requestInit: {headers: {authorization: `Bearer ${key}`}}});
  const client = new Client({name: 'eras-2025', version: '1'});
  await client.connect(transport);
  try {
    expect(transport.protocolVersion).toBe('2025-11-25');
    expect(client.getInstructions()).toContain('qoopia_protocol');
    // Autosave reaches a hookless agent in both eras: initialize here, server/discover below.
    expect(client.getInstructions()).toContain(AUTOSAVE_INSTRUCTION);
    expect((await client.listTools()).tools.map(t => t.name)).toContain('recall');
  } finally { await client.close(); }
});

test('a 2026-07-28 client discovers, lists the tools and calls one without initialize', async () => {
  const [discoverStatus, discover] = await modern('server/discover');
  expect([discoverStatus, discover.result.supportedVersions]).toEqual([200, ['2026-07-28']]);
  expect(discover.result.instructions).toContain('qoopia_protocol');
  expect(discover.result.instructions).toContain(AUTOSAVE_INSTRUCTION);
  const [listStatus, list] = await modern('tools/list');
  expect(listStatus).toBe(200);
  expect(list.result.tools.map((t: {name: string}) => t.name)).toContain('recall');
  const [, call] = await modern('tools/call', {name: 'qoopia_protocol', arguments: {language: 'en'}}, 'qoopia_protocol');
  expect([call.result.isError ?? false, call.result.content[0].type]).toEqual([false, 'text']);
  // An unknown tool stays a bounded NOT_FOUND tool result on this revision too.
  const [, unknown] = await modern('tools/call', {name: 'nope', arguments: {}}, 'nope');
  expect(unknown.result.content[0].text).toStartWith('NOT_FOUND: ');
});

test('subscriptions/listen closes at once: the catalogue never changes mid-connection, so no idle stream (F-261)', async () => {
  const [status, end] = await modern('subscriptions/listen', {notifications: {toolsListChanged: true}});
  expect([status, end.id, end.result.resultType]).toEqual([200, 1, 'complete']);
});

test('a 2026-07-28 request without the Mcp-Method header is refused', async () => {
  const r = await fetch(`${base}/mcp`, {method: 'POST', headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28'},
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}}}})});
  expect(r.status).toBe(400); await r.body?.cancel();
});
