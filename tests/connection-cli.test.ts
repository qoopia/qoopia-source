import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildOwnerPeer } from '../scripts/build-owner-peer.ts';
import { runConnectionCommand } from '../src/delivery/connection-cli.ts';
import { selectServerWorkspace } from '../src/delivery/remote.ts';
import { startOwnerControl } from '../src/delivery/owner-control.ts';
import { ownerControlRequest } from '../src/delivery/owner-onboarding.ts';
import { ownerSocketPath } from '../src/delivery/platform-paths.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { p1Database } from './helpers/p1-fixtures.ts';

test('connections on a server workspace defer to the selected server without local login', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connection-cli-server-')));
  try {
    selectServerWorkspace(root, 'https://a.example');
    expect(await runConnectionCommand(root, { action: 'status' })).toMatchObject({ state: 'requires_user_action', code: 'SERVER_WORKSPACE' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('connections sign in through owner IPC, refuse a login without a session cookie, then forward with cookie and CSRF', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connection-cli-'))), database = p1Database(37);
  const requests: { path: string; headers: Headers; body: unknown }[] = [];
  let cookie: string | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.json() });
    if (new URL(request.url).pathname === '/api/dashboard/local-login')
      return new Response('{}', { headers: cookie ? { 'set-cookie': cookie } : {} });
    return Response.json({ state: 'forwarded' });
  } });
  let close: (() => void) | undefined;
  try {
    const library = buildOwnerPeer(root);
    close = startOwnerControl(root, input => ownerControlRequest(database, input), library);
    fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ format: 'qoopia-installation/1', generation: 'generation-' + randomUUID(),
      bundle: 'a'.repeat(64), bundle_digest: 'a'.repeat(64), instance: 'instance', port: server.port }), { mode: 0o600 });
    const input = { action: 'status' };
    expect(await runConnectionCommand(root, input, undefined, library)).toMatchObject({ code: 'OWNER_LOGIN_REQUIRED' });
    expect(requests).toHaveLength(0);
    bootstrapOwner(database, 'Connection owner', 'Connection workspace');
    expect(await runConnectionCommand(root, input, undefined, library)).toMatchObject({ state: 'error', code: 'OWNER_LOGIN_FAILED' });
    expect(requests.map(r => r.path)).toEqual(['/api/dashboard/local-login']);
    cookie = 'qoopia_dash=fixture; Path=/api/dashboard; HttpOnly';
    expect(await runConnectionCommand(root, input, undefined, library)).toEqual({ state: 'forwarded' });
    const [login, setup] = requests.slice(1);
    expect(login!.body).toEqual({ code: expect.any(String) });
    expect(setup!.path).toBe('/api/dashboard/connection-setup');
    expect(setup!.body).toEqual(input);
    expect(setup!.headers.get('cookie')).toBe('qoopia_dash=fixture');
    expect(setup!.headers.get('origin')).toBe(`http://127.0.0.1:${server.port}`);
    expect(setup!.headers.get('x-qoopia-csrf')).toBe('1');
  } finally {
    close?.(); server.stop(true); database.close();
    fs.rmSync(path.dirname(ownerSocketPath(root, true)), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
