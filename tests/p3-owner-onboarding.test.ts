import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { ownerFixture, p1Database } from './helpers/p1-fixtures.ts';
import { ownerControlRequest } from '../src/delivery/owner-onboarding.ts';
import { consumeLocalLogin, issueLocalLogin, parseLocalLoginBody } from '../src/delivery/local-login.ts';
import { platformPaths, ownerSocketPath } from '../src/delivery/platform-paths.ts';
import { openOwnerPeer } from '../src/delivery/owner-control.ts';
import { buildOwnerPeer } from '../scripts/build-owner-peer.ts';
import { spawnSync } from 'node:child_process';

test('native bridge uses actual kernel credentials and refuses wrong expected UID/invalid descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-peer-unit-'));
  try {
    const library = buildOwnerPeer(root), native = openOwnerPeer(library);
    try { expect(native.symbols.qp_peer(-1, process.getuid!())).toBe(-1); } finally { native.close(); }
    const binary = path.join(root, 'peer-check');
    const compile = spawnSync('cc', ['-std=c11','-Wall','-Wextra','-Werror','tests/helpers/p3-peer-check.c','-o',binary], { encoding: 'utf8' });
    expect(compile.status).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    expect(run.stderr).toBe(''); expect(run.status).toBe(0);
    expect(run.stdout).toContain('PASS kernel socketpair credentials');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('first owner claim is single-use, existing owner login preserves identity and active human authority', () => {
  const d = p1Database(37);
  try {
    const first = ownerControlRequest(d, { operation: 'bootstrap', name: 'Fixture human' });
    expect('code' in first).toBe(true);
    const owner = d.query('SELECT actor_id FROM workspace_owners').get() as { actor_id: string };
    if (!('code' in first)) throw new Error('Missing fixture code');
    expect(consumeLocalLogin(first.code)).toBe(owner.actor_id);
    expect(consumeLocalLogin(first.code)).toBeNull();
    expect(() => ownerControlRequest(d, { operation: 'bootstrap', name: 'Second claimant' })).toThrow('already bound');
    expect(d.query('SELECT count(*) n FROM workspace_owners').get()).toEqual({ n: 1 });
    const login = ownerControlRequest(d, { operation: 'login' });
    if (!('code' in login)) throw new Error('Missing fixture code');
    expect(consumeLocalLogin(login.code)).toBe(owner.actor_id);
    expect(() => ownerControlRequest(d, { operation: 'login', ownerId: 'foreign' })).toThrow('active human');
    expect(() => ownerControlRequest(d, { operation: 'login', uid: process.getuid!() })).toThrow();
    for (const update of ["active=0", "active=1,principal_kind='agent'", "principal_kind='human',authority_profile='memory-worker'"]) {
      d.query(`UPDATE agents SET ${update} WHERE id=?`).run(owner.actor_id);
      expect(() => ownerControlRequest(d, { operation: 'login', ownerId: owner.actor_id })).toThrow('active human');
    }
  } finally { d.close(); }
});

test('existing unowned workspace requires explicit mapping; multiple owners require explicit selection', () => {
  const f = ownerFixture(37), d = f.database;
  try {
    d.query('DELETE FROM workspace_owners').run();
    const workspace = (d.query('SELECT id FROM workspaces LIMIT 1').get() as {id:string}).id;
    expect(() => ownerControlRequest(d, { operation: 'bootstrap', name: 'Mapped human' })).toThrow('explicit');
    const mapped = ownerControlRequest(d, { operation: 'bootstrap', name: 'Mapped human', workspaceId: workspace });
    expect('code' in mapped).toBe(true);
    d.query("INSERT INTO workspaces(id,name,slug) VALUES ('second','Second','second')").run();
    const second = bootstrapOwner(d, 'Second human', undefined, 'second');
    expect(() => ownerControlRequest(d, {operation:'login'})).toThrow('Select');
    const selected = ownerControlRequest(d, {operation:'login',ownerId:second.agent_id});
    if (!('code' in selected)) throw new Error('Missing fixture code');
    expect(consumeLocalLogin(selected.code)).toBe(second.agent_id);
  } finally { d.close(); }
});

test('login expiry boundary, replacement and malformed POST preserve meaningful capability checks', () => {
  const old = issueLocalLogin('one', 100), current = issueLocalLogin('two', 101);
  expect(consumeLocalLogin(old, 102)).toBeNull();
  expect(consumeLocalLogin(current, 300101)).toBeNull();
  const fresh = issueLocalLogin('three', 200);
  for (const [body, type] of [
    [JSON.stringify({ code: fresh, ownerId: 'fake' }), 'application/json'],
    [`code=${fresh}&code=${fresh}`, 'application/x-www-form-urlencoded'],
    [JSON.stringify({ code: fresh }), 'text/plain'],
    ['null', 'application/json'],
  ]) expect(() => parseLocalLoginBody(Buffer.from(body!), type)).toThrow();
  expect(parseLocalLoginBody(Buffer.from(`code=${fresh}`), 'application/x-www-form-urlencoded; charset=UTF-8')).toBe(fresh);
  expect(parseLocalLoginBody(Buffer.from(JSON.stringify({code:fresh})), 'application/json')).toBe(fresh);
  expect(consumeLocalLogin(fresh, 300199)).toBe('three');
});

test('platform paths use macOS and Linux XDG defaults, explicit isolated root and short protected socket paths', () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-path-unit-')));
  try {
    const home = path.join(parent, 'Home Ж space');
    const mac = platformPaths(undefined, 'darwin', {}, home);
    expect(mac.root).toBe(path.join(home, 'Library/Application Support/Qoopia'));
    expect(mac.logs).toBe(path.join(home, 'Library/Logs/Qoopia'));
    const linux = platformPaths(undefined, 'linux', { XDG_DATA_HOME: parent+'/data', XDG_CONFIG_HOME: parent+'/config', XDG_STATE_HOME: parent+'/state' }, home);
    expect(linux).toEqual({root:parent+'/data/qoopia',config:parent+'/config/qoopia',state:parent+'/state/qoopia',logs:parent+'/state/qoopia/logs'});
    expect(() => platformPaths(undefined, 'linux', {XDG_DATA_HOME:'relative'}, home)).toThrow('absolute');
    const explicit = platformPaths(parent+'/isolated', 'linux', {XDG_DATA_HOME:'/unused'}, home);
    expect(explicit.logs).toBe(parent+'/isolated/logs');
    const socket = ownerSocketPath(parent+'/long Ж '.repeat(40), true), dir = path.dirname(socket);
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    expect(() => ownerSocketPath(parent+'/long Ж '.repeat(40))).toThrow('Unsafe');
    fs.chmodSync(dir, 0o700); fs.rmdirSync(dir);
    const link = path.join(parent,'alias'); fs.symlinkSync(parent,link);
    expect(() => platformPaths(link)).toThrow('Links');
  } finally { fs.rmSync(parent, {recursive:true,force:true}); }
});
