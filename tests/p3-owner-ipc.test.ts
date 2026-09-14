import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ptr } from 'bun:ffi';
import { buildOwnerPeer } from '../scripts/build-owner-peer.ts';
import { startOwnerControl, requestOwnerLogin, openOwnerPeer } from '../src/delivery/owner-control.ts';
import { ownerControlRequest } from '../src/delivery/owner-onboarding.ts';
import { ownerSocketPath } from '../src/delivery/platform-paths.ts';
import { consumeLocalLogin } from '../src/delivery/local-login.ts';
import { p1Database } from './helpers/p1-fixtures.ts';

test('real IPC authenticates both peers, races first claim once, preserves owner identity and refuses malformed requests', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-ipc-'))), database = p1Database(37);
  let close: (()=>void) | undefined;
  try {
    const library = buildOwnerPeer(root);
    close = startOwnerControl(root, input => ownerControlRequest(database, input), library);
    const socket = ownerSocketPath(root);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
    const claims = await Promise.all(['A','B'].map(name => requestOwnerLogin(root, {operation:'bootstrap',name}, library)));
    expect(claims.filter(result => 'code' in result)).toHaveLength(1);
    expect(claims.filter(result => 'error' in result)).toHaveLength(1);
    const owner = database.query('SELECT actor_id FROM workspace_owners').get() as {actor_id:string};
    const successful = claims.find(result => 'code' in result)!;
    if (!('code' in successful)) throw new Error('Missing code');
    expect(consumeLocalLogin(successful.code)).toBe(owner.actor_id);
    expect(consumeLocalLogin(successful.code)).toBeNull();
    const login = await requestOwnerLogin(root, {operation:'login'}, library);
    expect('code' in login).toBe(true);
    const native = openOwnerPeer(library), api = native.symbols;
    try {
      // Kernel reports actual server UID; deliberately wrong expected UID must refuse.
      expect(api.qp_connect(ptr(Buffer.from(socket+'\0')), process.getuid!()+1)).toBe(-1);
      const fd = api.qp_connect(ptr(Buffer.from(socket+'\0')), process.getuid!());
      expect(fd).toBeGreaterThanOrEqual(0);
      try {
        const payload = Buffer.from('{"operation":"login","uid":0}\n');
        expect(api.qp_write(fd, ptr(payload), payload.length)).toBe(payload.length);
        await Bun.sleep(80);
        const response = Buffer.alloc(4096), n = api.qp_read(fd,ptr(response),response.length);
        expect(n).toBeGreaterThan(0);
        expect(JSON.parse(response.subarray(0,n).toString())).toHaveProperty('error');
      } finally { api.qp_close(fd); }
    } finally { native.close(); }
    database.query('UPDATE agents SET active=0 WHERE id=?').run(owner.actor_id);
    expect(await requestOwnerLogin(root, {operation:'login'}, library)).toHaveProperty('error');
    close(); close=undefined;
    expect(fs.existsSync(socket)).toBe(false);
  } finally {
    close?.(); database.close();
    const directory = path.dirname(ownerSocketPath(root, true));
    fs.rmSync(directory, {recursive:true,force:true});
    fs.rmSync(root,{recursive:true,force:true});
  }
}, 15000);

test('native accept rejects actual peer when policy UID mismatches before returning a descriptor', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-ipc-deny-')));
  const socket = ownerSocketPath(root,true), native = openOwnerPeer(buildOwnerPeer(root)), api = native.symbols;
  let listener = -1, client = -1;
  try {
    listener=api.qp_listen(ptr(Buffer.from(socket+'\0'))); expect(listener).toBeGreaterThanOrEqual(0);
    client=api.qp_connect(ptr(Buffer.from(socket+'\0')),process.getuid!()); expect(client).toBeGreaterThanOrEqual(0);
    expect(api.qp_accept(listener,process.getuid!()+1)).toBe(-1);
    expect(api.qp_accept(listener,process.getuid!())).toBe(-2);
  } finally {
    if(client>=0)api.qp_close(client); if(listener>=0)api.qp_close(listener); native.close();
    fs.rmSync(path.dirname(socket),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});
  }
});
