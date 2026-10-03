/** F-262/F-263: the Claude Desktop stdio adapter passes the server instructions, and a long call in one
 * adapter process does not hold the OAuth lock against another process of the same connection. */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {serveStdioClient} from '../src/delivery/stdio-client.ts';
import {stdioFolder, type StdioBinding} from '../src/delivery/stdio-oauth.ts';
import {privateDirectory, durableWrite} from '../src/utils/fs.ts';
import {MCP_INSTRUCTIONS} from '../src/agent-kit/index.ts';

let upstream: http.Server, root = '', binding: StdioBinding;
beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    const server = new McpServer({name: 'synthetic-upstream', version: '1'});
    server.registerTool('slow', {inputSchema: {ms: z.number()}}, async ({ms}) => { await new Promise(r => setTimeout(r, ms)); return {content: [{type: 'text', text: 'slow done'}]}; });
    server.registerTool('fast', {inputSchema: {}}, async () => ({content: [{type: 'text', text: 'fast done'}]}));
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const id = randomUUID(), port = (upstream.address() as {port: number}).port;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-stdio-adapter-')));
  binding = {format: 'qoopia-client-connection/1', connection_id: id, workspace_id: 'fixture', surface: 'claude_desktop', access_mode: 'read_write', mcp_url: `http://127.0.0.1:${port}/mcp/c/${id}`};
  const folder = stdioFolder(root, binding); privateDirectory(folder);
  durableWrite(path.join(folder, 'oauth.json'), JSON.stringify({format: 'qoopia-stdio-oauth/1', binding, redirect_uri: 'http://127.0.0.1:1/qoopia/callback', tokens: {access_token: 'synthetic', token_type: 'Bearer'}}));
});
afterAll(() => { upstream.closeAllConnections(); upstream.close(); fs.rmSync(root, {recursive: true, force: true}); });

async function adapter(selected: StdioBinding = binding) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = await serveStdioClient(root, selected, serverSide);
  const client = new Client({name: 'desktop-fixture', version: '1'}); await client.connect(clientSide);
  return {client, close: async () => { await client.close(); await handle.close(); }};
}

test('F-262: Desktop receives the server instructions through the adapter', async () => {
  const a = await adapter();
  try { expect(a.client.getInstructions()).toBe(MCP_INSTRUCTIONS); } finally { await a.close(); }
});

test('F-263: another adapter process of the connection is not blocked by a long call', async () => {
  const a = await adapter(), b = await adapter();
  try {
    const order: string[] = [];
    const slow = a.client.callTool({name: 'slow', arguments: {ms: 1500}}).then(r => { order.push('slow'); return r; });
    await new Promise(r => setTimeout(r, 200));
    const fast = await b.client.callTool({name: 'fast', arguments: {}}); order.push('fast');
    expect((fast.content as {text: string}[])[0]!.text).toBe('fast done');
    expect((await slow).isError).not.toBe(true);
    expect(order).toEqual(['fast', 'slow']);
  } finally { await a.close(); await b.close(); }
}, 20_000);

test('F-263: an adapter error carries its code once, not a doubled MCP error prefix', async () => {
  const id = randomUUID(), a = await adapter({...binding, connection_id: id, mcp_url: new URL(binding.mcp_url).origin + '/mcp/c/' + id});
  try {
    const message = await a.client.callTool({name: 'fast', arguments: {}}).then(() => '', (error: Error) => error.message);
    expect(message).toStartWith('MCP error -32001: CLIENT_AUTH_REQUIRED: ');
    expect(message.split('MCP error').length).toBe(2);
  } finally { await a.close(); }
});
