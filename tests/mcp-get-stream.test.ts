/** F-261: stateless /mcp offers no standalone SSE stream; GET and DELETE are 405 after authentication. */
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

let server: Server, base = '', key = '';
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({name: 'MCP GET', slug: 'mcp-get-stream'});
  key = createAgent({name: 'mcp-get-agent', workspaceSlug: ws.slug}).api_key;
  server = startHttpServer(); if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });

test('authenticated GET and DELETE /mcp answer 405 Allow: POST at once; anonymous GET keeps the OAuth challenge', async () => {
  for (const method of ['GET', 'DELETE']) {
    const r = await fetch(`${base}/mcp`, {method, headers: {authorization: `Bearer ${key}`, accept: 'text/event-stream'}, signal: AbortSignal.timeout(3000)});
    expect([method, r.status, r.headers.get('allow')]).toEqual([method, 405, 'POST']);
    await r.body?.cancel();
  }
  const anonymous = await fetch(`${base}/mcp`, {headers: {accept: 'text/event-stream'}});
  expect(anonymous.status).toBe(401); await anonymous.body?.cancel();
});

test('the SDK client still connects and calls a tool', async () => {
  const client = new Client({name: 'get-stream', version: '1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {requestInit: {headers: {authorization: `Bearer ${key}`}}}));
  try { expect((await client.callTool({name: 'brief', arguments: {}})).isError).not.toBe(true); }
  finally { await client.close(); }
});
