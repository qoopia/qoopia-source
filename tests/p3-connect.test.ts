import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, DB_PATH } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { connectInstalled } from '../src/delivery/connect.ts';
import { lockInstallation } from '../src/delivery/operations.ts';
import { hash } from '../src/delivery/files.ts';
import { connectRuntimes, connectConfigFixture, connectState, assertConnectOutput, assertConnectPreview,
  assertConfiguredConnect, type ConnectContext, type ConnectInput } from './helpers/p3-connect-fixtures.ts';

// bunfig.toml -> tests/setup.ts owns the disposable DB. No bundle, socket,
// CLI subprocess or native runtime is required for default suite coverage.
// CLI parsing/dispatch, compiled owner IPC and installed HTTP stay in p3-connect-check.ts.
let outer: string, context: ConnectContext, owner: ReturnType<typeof bootstrapOwner>, databaseMode: number;
beforeEach(() => {
  runMigrations();
  // entry.ts::configure uses umask(077); the suite's SQLite opener does not.
  // Change only its preload-owned disposable DB, and restore for other tests.
  databaseMode = fs.statSync(DB_PATH).mode & 0o777;
  fs.chmodSync(DB_PATH, 0o600);
  outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-connect-suite-')));
  const workspace = randomUUID();
  db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace, 'Connect suite', workspace);
  owner = bootstrapOwner(db, 'Connect suite owner', undefined, workspace);
  context = { root: path.join(outer, 'Installed Ж space'),
    instance: (db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as { instance_id: string }).instance_id,
    bundle: 'a'.repeat(64), generation: 'generation-' + randomUUID(), port: 43737 };
});
afterEach(() => {
  fs.chmodSync(DB_PATH, databaseMode);
  fs.rmSync(outer, { recursive: true, force: true });
});

async function connect(input: ConnectInput, approval?: string, selected = context) {
  // Honor the documented caller precondition with the actual installation lock.
  const release = lockInstallation(selected.root);
  try {
    const result = await connectInstalled(input, selected, approval);
    assertConnectOutput(JSON.stringify(result));
    return result;
  } catch (error) {
    assertConnectOutput(String(error));
    throw error;
  } finally { release(); }
}

for (const runtime of connectRuntimes) for (const existing of [false, true]) {
  test(`connect source: ${runtime} ${existing ? 'existing' : 'fresh'} config, scoped SDK probe and preserved settings`, async () => {
    const fixture = connectConfigFixture(outer, runtime, existing);
    const input = { runtime, config: fixture.config, name: path.basename(fixture.home), ownerId: owner.agent_id };
    const before = connectState(db);
    const preview = await connect(input); assertConnectPreview(preview);
    expect(connectState(db)).toBe(before);
    expect(fs.existsSync(fixture.config)).toBe(existing);
    if (existing) expect(fs.readFileSync(fixture.config, 'utf8')).toBe(fixture.original);
    expect(preview.before_sha256).toBe(existing ? hash(fixture.original) : null);
    expect(preview.owner_id).toBe(owner.agent_id);
    const result = await connect(input, preview.preview_digest);
    assertConfiguredConnect(db, fixture, result, context);
    expect(result.workspace_id).toBe(owner.workspace_id);
    expect(result.preview_digest).toBe(preview.preview_digest);
    const after = connectState(db);
    const published = fs.readFileSync(fixture.config);
    await expect(connect(input)).rejects.toThrow('Principal name already exists');
    expect(connectState(db)).toBe(after);
    expect(fs.readFileSync(fixture.config)).toEqual(published);
  });
}

test('connect source: approval binds file, installation, human owner epoch and session before enrollment', async () => {
  const fixture = connectConfigFixture(outer, 'claude_code', false);
  const input = { runtime: fixture.runtime, config: fixture.config, name: 'approval', ownerId: owner.agent_id };
  const preview = await connect(input); assertConnectPreview(preview);
  const before = connectState(db);
  await expect(connect(input, '0'.repeat(64))).rejects.toThrow('approval mismatched');
  fs.writeFileSync(fixture.config, '{}', { mode: 0o600 });
  await expect(connect(input, preview.preview_digest)).rejects.toThrow('preview changed');
  expect(fs.readFileSync(fixture.config, 'utf8')).toBe('{}');
  fs.unlinkSync(fixture.config);
  for (const selected of [{ ...context, port: context.port + 1 }, { ...context, generation: 'generation-' + randomUUID() }]) {
    await expect(connect(input, preview.preview_digest, selected)).rejects.toThrow('preview changed');
  }
  expect(connectState(db)).toBe(before);
  for (const field of ['policy_epoch', 'session_version']) {
    const fresh = await connect(input); assertConnectPreview(fresh);
    db.query(`UPDATE agents SET ${field}=${field}+1 WHERE id=?`).run(owner.agent_id);
    const changed = connectState(db);
    await expect(connect(input, fresh.preview_digest)).rejects.toThrow('preview changed');
    expect(connectState(db)).toBe(changed);
  }
  expect(fs.existsSync(fixture.config)).toBe(false);
});

test('connect source: malformed, insecure, linked and claimed config or nonhuman owner fail without enrollment', async () => {
  const fixture = connectConfigFixture(outer, 'claude_code', false);
  const input = { runtime: fixture.runtime, config: fixture.config, name: 'negative', ownerId: owner.agent_id };
  const before = connectState(db);
  fs.chmodSync(DB_PATH, 0o644);
  try { await expect(connect(input)).rejects.toThrow('private database owner local OS session'); }
  finally { fs.chmodSync(DB_PATH, 0o600); }
  fs.writeFileSync(fixture.config, '{}', { mode: 0o644 });
  await expect(connect(input)).rejects.toThrow('private (0600)');
  fs.chmodSync(fixture.config, 0o600);
  for (const text of ['{bad', '{"mcpServers":{"qoopia":{}}}']) {
    fs.writeFileSync(fixture.config, text);
    await expect(connect(input)).rejects.toThrow('Config malformed or qoopia entry already exists');
    expect(fs.readFileSync(fixture.config, 'utf8')).toBe(text);
  }
  fs.unlinkSync(fixture.config);
  const target = path.join(fixture.home, 'target.json'); fs.writeFileSync(target, '{}', { mode: 0o600 });
  for (const link of [fs.symlinkSync, fs.linkSync]) {
    link(target, fixture.config);
    await expect(connect(input)).rejects.toThrow('Links and special files');
    fs.unlinkSync(fixture.config);
    expect(fs.readFileSync(target, 'utf8')).toBe('{}');
  }
  fs.chmodSync(fixture.home, 0o755);
  try { await expect(connect(input)).rejects.toThrow('private (0700)'); }
  finally { fs.chmodSync(fixture.home, 0o700); }
  expect(connectState(db)).toBe(before);
  db.query("UPDATE agents SET principal_kind='agent' WHERE id=?").run(owner.agent_id);
  const changed = connectState(db);
  await expect(connect(input)).rejects.toThrow('active human owner');
  expect(connectState(db)).toBe(changed);
  expect(fs.existsSync(fixture.config)).toBe(false);
});

test('connect source: actual sample write failure revokes enrollment and leaves config unpublished', async () => {
  const fixture = connectConfigFixture(outer, 'claude_code', false);
  const input = { runtime: fixture.runtime, config: fixture.config, name: 'rejected sample', ownerId: owner.agent_id };
  const preview = await connect(input); assertConnectPreview(preview);
  // Same failure injection as the compiled gate, scoped to this test's workspace.
  db.run(`CREATE TEMP TRIGGER fixture_reject_connect BEFORE INSERT ON notes
    WHEN NEW.workspace_id='${owner.workspace_id}' BEGIN SELECT RAISE(ABORT, 'fixture write refusal'); END`);
  try {
    await expect(connect(input, preview.preview_digest)).rejects.toThrow('Connect failed at FIRST_MEMORY_WRITE');
  } finally { db.run('DROP TRIGGER fixture_reject_connect'); }
  expect(fs.existsSync(fixture.config)).toBe(false);
  expect(db.query('SELECT active FROM agents WHERE workspace_id=? AND name=?').get(owner.workspace_id, input.name)).toEqual({ active: 0 });
  expect(db.query('SELECT id FROM notes WHERE workspace_id=?').all(owner.workspace_id)).toEqual([]);
});

for (const runtime of connectRuntimes) test(`installed native binding: ${runtime} consumes only approved connection and fences drift`, async () => {
  const fixture = connectConfigFixture(outer, runtime, true);
  const input = { runtime, config: fixture.config, name: 'native-bound', ownerId: owner.agent_id };
  const preview = await connect(input); assertConnectPreview(preview);
  const result = await connect(input, preview.preview_digest);
  expect('connection' in result).toBe(true);
  if (!('connection' in result)) throw new Error('Installed native connection receipt missing');
  assertConfiguredConnect(db, fixture, result, context);
  const { bindNativeConnection, nativeMcpTools } = await import('../src/skills/connection.ts');
  const { nativeLaunch, QUALIFICATION_MODELS } = await import('../src/skills/adapter.ts');
  fs.writeFileSync(path.join(context.root, 'current.json'), JSON.stringify({ format: 'qoopia-installation/1',
    ...Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'root')), bundle_digest: context.bundle }), { mode: 0o600 });
  const expected = { runtime_id: result.runtime_registration_id, runtime_kind: runtime, workspace_id: owner.workspace_id };
  const bound = bindNativeConnection(db, result.connection, expected);
  const login = path.join(outer, 'synthetic-login'); fs.mkdirSync(login, { mode: 0o700 });
  const home = path.join(outer, 'native-attempt');
  const options = { auth_mode: 'subscription-store', ...QUALIFICATION_MODELS[runtime], connection: result.connection,
    login_backend: runtime === 'codex' ? 'file' : 'config-dir', login_store: login };
  const launch = nativeLaunch(runtime, outer, 'Explicit bound task', options, { PATH: '/no-native-binaries' }, home, bound);
  const envOptions = { auth_mode: 'subscription', ...QUALIFICATION_MODELS[runtime], connection: result.connection };
  if (runtime === 'claude_code') {
    const synthetic = 'synthetic-selected-claude-oauth';
    const selected = nativeLaunch(runtime, outer, 'Explicit env-bound task', envOptions,
      { PATH: '/no-native-binaries', CLAUDE_CODE_OAUTH_TOKEN: synthetic, ANTHROPIC_API_KEY: 'unused-api' }, home, bound);
    expect(selected.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(synthetic);
    expect(selected.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(selected)).not.toContain(synthetic);
    expect(selected.scrub(synthetic)).not.toContain(synthetic);
    expect(selected.args).toContain('--strict-mcp-config');
    expect(() => nativeLaunch(runtime, outer, 'Missing auth', envOptions, {}, home, bound)).toThrow('authentication unavailable');
    expect(() => nativeLaunch(runtime, outer, 'Ambiguous auth', { ...envOptions, login_store: login }, {}, home, bound)).toThrow('Login store selection');
  } else {
    expect(() => nativeLaunch(runtime, outer, 'No Codex env widening', envOptions, {}, home, bound)).toThrow('subscription');
  }
  expect(() => nativeLaunch(runtime, outer, 'No API connection', { ...envOptions, auth_mode: 'api-key' }, {}, home, bound)).toThrow('subscription');
  expect(JSON.stringify(launch)).not.toMatch(/q_[A-Za-z0-9_-]{43}|unrelated-fixture-secret/);
  if (runtime === 'codex') {
    expect(launch.args).toContain('--ignore-user-config');
    expect(launch.args).toContain('mcp_servers.qoopia.env_http_headers={Authorization="QOOPIA_NATIVE_MCP_AUTH"}');
    expect(launch.args).toContain(`mcp_servers.qoopia.enabled_tools=${JSON.stringify(nativeMcpTools)}`);
    expect(launch.args).toContain('mcp_servers.qoopia.default_tools_approval_mode="prompt"');
    for (const tool of nativeMcpTools) {
      expect(launch.args).toContain(`mcp_servers.qoopia.tools.${tool}.enabled=true`);
      expect(launch.args).toContain(`mcp_servers.qoopia.tools.${tool}.approval_mode="approve"`);
    }
    expect(launch.args.filter(arg => arg.includes('.approval_mode='))).toHaveLength(nativeMcpTools.length);
    expect(launch.args).not.toContain('mcp_servers.qoopia.default_tools_approval_mode="approve"');
    expect(launch.env.QOOPIA_NATIVE_MCP_AUTH).toMatch(/^Bearer q_/);
  } else {
    expect(launch.args).toContain('--strict-mcp-config');
    expect(launch.args[launch.args.indexOf('--mcp-config') + 1]).toBe(path.join(home, 'qoopia-mcp.json'));
    expect(launch.args.at(-2)).toBe('--');
  }
  expect(() => nativeLaunch(runtime, outer, 'Unbound', options, { PATH: '/no-native-binaries' }, home)).toThrow('validated connection');
  expect(() => bindNativeConnection(db, result.connection, { ...expected, runtime_id: 'other' })).toThrow();
  db.query('UPDATE agents SET policy_epoch=policy_epoch+1 WHERE id=?').run(result.agent_id);
  expect(() => bindNativeConnection(db, result.connection, expected)).toThrow();
  db.query('UPDATE agents SET policy_epoch=policy_epoch-1 WHERE id=?').run(result.agent_id);
  fs.chmodSync(fixture.config, 0o644);
  expect(() => bindNativeConnection(db, result.connection, expected)).toThrow();
  fs.chmodSync(fixture.config, 0o600);
  const bytes = fs.readFileSync(fixture.config);
  fs.writeFileSync(fixture.config, Buffer.concat([bytes, Buffer.from('\n')]));
  expect(() => bindNativeConnection(db, result.connection, expected)).toThrow();
});
