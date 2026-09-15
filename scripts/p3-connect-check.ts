// Disposable compiled T01 plumbing only. --sockets is for Leo outside the builder sandbox.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { Delivery, dataFile, readCurrent, lockInstallation } from '../src/delivery/operations.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { hash } from '../src/utils/fs.ts';
import { verifyBundle } from '../src/delivery/bundle.ts';
import { connectRuntimes, connectConfigFixture, connectState, assertConnectOutput, assertConnectPreview, assertConfiguredConnect,
  type ConnectResult, type ConfiguredConnect, type ConnectInput } from '../tests/helpers/p3-connect-fixtures.ts';
const args = process.argv.slice(2), bundle = path.resolve(args[args.indexOf('--bundle') + 1]!);
const socketMode = args.includes('--sockets');
const trust = fs.readFileSync(path.join(bundle, 'TEST-PUBLIC-KEY.pem'), 'utf8');
const verified = verifyBundle(bundle, trust, true);
const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-connect-'))), root = path.join(outer, 'Installed Ж space');
const events: unknown[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
const isolated = { PATH: '/usr/bin:/bin', HOME: outer, TMPDIR: outer, XDG_CONFIG_HOME: outer, XDG_DATA_HOME: outer };
const run = (binary: string, command: string[], expected = 0) => {
  const started = performance.now();
  const result = spawnSync(binary, command, { encoding: 'utf8', cwd: outer, env: isolated, timeout: 90000 });
  assertConnectOutput(result.stdout + result.stderr);
  events.push({ command: command[0], exit: result.status, elapsed_ms: performance.now() - started, stdout_sha256: hash(result.stdout), stderr_sha256: hash(result.stderr) });
  assert.equal(result.status, expected, JSON.stringify({ command: command[0], stderr: result.stderr }));
  return result.stdout.trim();
};
try {
  if (socketMode) run(path.join(bundle, 'qoopia'), ['install', '--root', root, '--bundle', bundle, '--commit', '--allow-test-fixture']);
  else new Delivery(root, trust, true, (b, g) => { run(path.join(b, 'qoopia'), ['_migrate', '--root', g]); }).install(bundle, 43737);
  const current = readCurrent(root), binary = path.join(root, 'bundles', current.bundle, 'qoopia');
  const common = ['--root', root, '--allow-test-fixture'];
  const start = async () => {
    child = Bun.spawn([binary, 'start', ...common], { cwd: outer, env: isolated, stdout: 'ignore', stderr: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Compiled server exited');
      try { const response = await fetch(`http://127.0.0.1:${current.port}/health`); if (response.ok) return; } catch {}
      await Bun.sleep(50);
    }
    throw new Error('Compiled server start timeout');
  };
  const stop = async () => { if (child) { child.kill('SIGTERM'); await child.exited; child = undefined; } };
  if (socketMode) {
    await start();
    const { requestOwnerLogin } = await import('../src/delivery/owner-control.ts');
    const claim = await requestOwnerLogin(root, { operation: 'bootstrap', name: 'Socket fixture human' }, path.join(bundle, 'assets/native', `owner-peer.${process.platform === 'darwin' ? 'dylib' : 'so'}`));
    assert('code' in claim); // Never print it or submit it to a browser.
    await stop();
  } else {
    const database = new Database(dataFile(root, current));
    bootstrapOwner(database, 'Fixture human', 'Connect fixture'); database.close();
  }
  const database = new Database(dataFile(root, current));
  const counts = () => connectState(database);
  const files: { runtime: ConnectInput['runtime']; config: string; result: ConfiguredConnect }[] = [];
  for (const runtime of connectRuntimes) for (const existing of [false, true]) {
    const fixture = connectConfigFixture(outer, runtime, existing);
    const { home, config, original } = fixture;
    const input = ['connect', ...common, '--runtime', runtime, '--name', path.basename(home), '--config', config];
    const before = counts();
    const preview: ConnectResult = JSON.parse(run(binary, input)); assertConnectPreview(preview); assert.equal(counts(), before);
    assert.equal(fs.existsSync(config), existing); if (existing) assert.equal(fs.readFileSync(config, 'utf8'), original);
    run(binary, [...input, '--commit'], 1); run(binary, [...input, '--approve', preview.preview_digest], 1);
    run(binary, [...input, '--commit', '--approve', '0'.repeat(64)], 1);
    run(binary, [...input, '--name', 'duplicate-option'], 1);
    if (!existing) {
      fs.writeFileSync(config, runtime === 'codex' ? '# changed\n' : '{}', { mode: 0o600 });
      run(binary, [...input, '--commit', '--approve', preview.preview_digest], 1); fs.unlinkSync(config);
    }
    const owner = database.query('SELECT actor_id FROM workspace_owners').get() as { actor_id: string };
    database.query('UPDATE agents SET policy_epoch=policy_epoch+1 WHERE id=?').run(owner.actor_id);
    run(binary, [...input, '--commit', '--approve', preview.preview_digest], 1);
    const refreshed: ConnectResult = JSON.parse(run(binary, input)); assertConnectPreview(refreshed);
    const lock = lockInstallation(root); try { run(binary, input, 1); } finally { lock(); }
    const result: ConnectResult = JSON.parse(run(binary, [...input, '--commit', '--approve', refreshed.preview_digest]));
    assertConfiguredConnect(database, fixture, result, { root, ...current });
    const after = counts(); run(binary, input, 1); assert.equal(counts(), after);
    files.push({ runtime, config, result });
  }
  // Path/content/owner negative controls operate only on fake native homes.
  const negativeDir = path.join(outer, 'negative'); fs.mkdirSync(negativeDir, { mode: 0o700 });
  const config = path.join(negativeDir, 'bad.json'); const negative = ['connect', ...common, '--runtime', 'claude_code', '--name', 'negative', '--config', config];
  const beforeNegative = counts();
  fs.writeFileSync(config, '{}', { mode: 0o644 }); run(binary, negative, 1); fs.chmodSync(config, 0o600);
  fs.writeFileSync(config, '{bad'); run(binary, negative, 1); fs.unlinkSync(config);
  fs.symlinkSync(files[0]!.config, config); run(binary, negative, 1); fs.unlinkSync(config);
  fs.writeFileSync(config, '{}', { mode: 0o600 }); fs.linkSync(config, config + '-hard'); run(binary, negative, 1); fs.unlinkSync(config + '-hard');
  run(binary, [...negative, '--owner-id', files[0]!.result.agent_id], 1);
  fs.chmodSync(negativeDir, 0o755); run(binary, negative, 1); fs.chmodSync(negativeDir, 0o700);
  assert.equal(counts(), beforeNegative);
  // Real compiled failure path: a disposable DB trigger rejects the sample write.
  fs.unlinkSync(config);
  const failurePreview: ConnectResult = JSON.parse(run(binary, negative)); assertConnectPreview(failurePreview);
  database.run("CREATE TRIGGER fixture_reject_connect BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'fixture write refusal'); END");
  try { run(binary, [...negative, '--commit', '--approve', failurePreview.preview_digest], 1); }
  finally { database.run('DROP TRIGGER fixture_reject_connect'); }
  assert(!fs.existsSync(config));
  const rejected = database.query("SELECT active FROM agents WHERE name='negative'").get() as { active: number };
  assert.equal(rejected.active, 0);
  database.close();
  if (socketMode) {
    await start();
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    for (const file of files) {
      const parsed: any = file.runtime === 'codex' ? Bun.TOML.parse(fs.readFileSync(file.config, 'utf8')) : JSON.parse(fs.readFileSync(file.config, 'utf8'));
      const entry = (file.runtime === 'codex' ? parsed.mcp_servers : parsed.mcpServers).qoopia;
      const client = new Client({ name: 'disposable-http-check', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: file.runtime === 'codex' ? entry.http_headers : entry.headers } }));
        const catalog = await client.listTools(); assert(catalog.tools.some(tool => tool.name === 'note_create'));
        const result = await client.callTool({ name: 'note_get', arguments: { id: file.result.first_memory_id } });
        assert(!result.isError); assert(JSON.stringify(result).includes(file.result.first_memory_id));
        const denied = await client.callTool({ name: 'agent_pairing_create', arguments: {} }); assert(denied.isError);
      } finally { await client.close(); }
    }
    await stop();
  }
  console.log(JSON.stringify({ fixture_only: true, installed_manifest_sha256: verified.digest, cases: files.length,
    status: 'PASS bounded compiled connect fixtures', owner_bootstrap: socketMode ? 'actual compiled IPC' : 'direct fixture seed',
    transport: socketMode ? 'in-process plus actual installed HTTP SDK' : 'in-process SDK; sockets NOT RUN',
    native_runtimes: 'NOT RUN', clean_user_T01: 'NOT RUN', events }, null, 2));
} finally {
  if (child) { child.kill('SIGTERM'); await child.exited; }
  fs.rmSync(outer, { recursive: true, force: true });
}
