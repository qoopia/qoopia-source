/**
 * F-254: the managed MCP edge reaches the server over loopback. Remote clients must be
 * rate-limited per Cloudflare client address, apart from local loopback clients, and no
 * client (remote or local) can choose its own bucket by sending a forwarding header.
 */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import http, {type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {once} from 'node:events';
import {runMigrations} from '../src/db/migrate.ts';
import {startHttpServer} from '../src/http.ts';
import {startMcpEdge} from '../src/delivery/mcp-edge.ts';
import {authLimiter} from '../src/utils/rate-limit.ts';

let server: Server, edge: Server, serverPort = 0, edgePort = 0;
const HOST = 'edge-ip.example';
beforeAll(async () => {
  runMigrations();
  server = startHttpServer(); if (!server.listening) await once(server, 'listening');
  serverPort = (server.address() as AddressInfo).port;
  edge = startMcpEdge({publicOrigin: 'https://' + HOST, upstreamPort: serverPort}); if (!edge.listening) await once(edge, 'listening');
  edgePort = (edge.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of [edge, server]) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
});

const token = (port: number, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
  const body = 'grant_type=refresh_token&refresh_token=qr_invalid&client_id=none';
  const req = http.request({hostname: '127.0.0.1', port, path: '/oauth/token', method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ...headers}},
  res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
  req.on('error', reject); req.end(body);
});

test('edge clients get per-address buckets apart from loopback; forwarding headers cannot pick a bucket', async () => {
  const keys: string[] = [], allow = authLimiter.allow.bind(authLimiter);
  authLimiter.allow = (key: string) => { keys.push(key); return allow(key); };
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push(await token(edgePort, {host: HOST, 'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.' + i, 'x-qoopia-edge-client': 'forged 198.51.100.' + i}));
    expect(statuses.at(-1)).toBe(429);
    // Another remote client and the local owner are not locked out by that stranger.
    expect(await token(edgePort, {host: HOST, 'cf-connecting-ip': '203.0.113.8'})).not.toBe(429);
    keys.length = 0;
    await token(serverPort, {host: '127.0.0.1:' + serverPort});
    // A local process cannot impersonate the edge or a remote address.
    await token(serverPort, {host: '127.0.0.1:' + serverPort, 'x-qoopia-edge-client': 'forged 203.0.113.9', 'cf-connecting-ip': '203.0.113.9'});
    expect(keys.length).toBe(2);
    for (const key of keys) expect(key).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  } finally { authLimiter.allow = allow; }
}, 30_000);

test('edge traffic without a Cloudflare address shares one bucket that is not the loopback one', async () => {
  const keys: string[] = [], allow = authLimiter.allow.bind(authLimiter);
  authLimiter.allow = (key: string) => { keys.push(key); return allow(key); };
  try {
    await token(edgePort, {host: HOST});
    await token(edgePort, {host: HOST, 'cf-connecting-ip': 'not-an-ip'});
    expect(keys).toEqual(['edge:unknown', 'edge:unknown']);
  } finally { authLimiter.allow = allow; }
});
