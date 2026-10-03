import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { inventory, hash, durableWrite, privateDirectory } from '../src/utils/fs.ts';

// Behavioral checks of the standalone dispatcher run from source. The build constants are
// injected with --define; HOME and --root are isolated so platform defaults and
// ~/Library/LaunchAgents are never touched; Bun's own cache is disabled so HOME stays empty.
let outer: string, home: string, root: string;
beforeEach(() => {
  outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'entry-dispatch-')));
  home = path.join(outer, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  root = path.join(outer, 'root');
});
afterEach(() => fs.rmSync(outer, { recursive: true, force: true }));

function entry(...args: string[]) {
  return spawnSync(process.execPath, ['--define', 'QOOPIA_PINNED_KEY="test"', '--define', 'QOOPIA_BUILD_SHA="test"', 'src/delivery/entry.ts', ...args],
    { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
}
const tree = (directory: string): string[] => fs.existsSync(directory)
  ? fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort().map(name => {
    const file = path.join(directory, name);
    return fs.statSync(file).isFile() ? name + ':' + fs.readFileSync(file, 'utf8') : name + '/';
  }) : [];

test('uninstall without --commit is preview-only', () => {
  for (const command of ['uninstall', 'rollback', 'backup', 'restore', 'migrate-source', 'maintenance']) {
    const result = entry(command, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ state: 'PREVIEW', command, requires: '--commit', data_preserved_by_default: true });
    expect(fs.existsSync(root)).toBe(false);
  }
  // An existing root is left byte-for-byte unchanged.
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'current.json'), '{"sentinel":true}', { mode: 0o600 });
  const before = tree(root);
  for (const command of ['uninstall', 'rollback', 'restore']) {
    const result = entry(command, '--root', root, '--backup', path.join(outer, 'backup'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state).toBe('PREVIEW');
  }
  expect(tree(root)).toEqual(before);
  expect(tree(home)).toEqual([]);
}, 20_000);

test('use-server previews without --commit, then local runtime commands refuse the server workspace', () => {
  const preview = entry('use-server', '--url', 'https://a.example', '--root', root);
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout)).toEqual({ state: 'PREVIEW', url: 'https://a.example/dashboard', requires: '--commit', local_data_preserved: true });
  expect(fs.existsSync(root)).toBe(false);
  const selected = entry('use-server', '--url', 'https://a.example', '--root', root, '--commit');
  expect(selected.status).toBe(0);
  expect(JSON.parse(selected.stdout).url).toBe('https://a.example/dashboard');
  const before = tree(root);
  for (const args of [['connect'], ['runtime', 'bind'], ['skill', 'get'], ['owner-login'], ['service', 'install']]) {
    const refused = entry(...args, '--root', root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('This installation uses a server workspace');
  }
  expect(tree(root)).toEqual(before);
}, 20_000);

test('memory-link refuses a connection from another server workspace origin', () => {
  expect(entry('use-server', '--url', 'https://a.example', '--root', root, '--commit').status).toBe(0);
  const file = path.join(outer, 'connection.json');
  fs.writeFileSync(file, JSON.stringify({ url: 'https://b.example/mcp', runtime: 'claude_code' }), { mode: 0o600 });
  const refused = entry('memory-link', '--file', file, '--root', root);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('Connection belongs to another workspace');
  expect(fs.existsSync(path.join(root, 'memory-clients'))).toBe(false);
  expect(tree(home)).toEqual([]);
}, 20_000);

test('client-link --commit applies only the exact reviewed plan digest', () => {
  const connection = randomUUID(), config = path.join(outer, 'claude');
  fs.mkdirSync(config, { mode: 0o700 });
  const file = path.join(outer, 'binding.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'qoopia-client-connection/1', connection_id: connection, workspace_id: 'workspace',
    surface: 'claude_code', access_mode: 'read', mcp_url: 'https://a.example/mcp/c/' + connection }), { mode: 0o600 });
  const args = ['client-link', '--file', file, '--root', root, '--config-directory', config];
  const plan = entry(...args);
  expect(plan.status).toBe(0);
  const reviewed = JSON.parse(plan.stdout);
  expect(reviewed.code).toBe('CLIENT_CONFIG_APPLY_REQUIRED');
  expect(reviewed.plan_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(tree(config)).toEqual([]);
  const refused = entry(...args, '--commit', '--approve', '0'.repeat(64));
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('Connection file changed after review');
  expect(tree(config)).toEqual([]);
  expect(fs.existsSync(path.join(root, 'client-configs'))).toBe(false);
  const applied = entry(...args, '--commit', '--approve', reviewed.plan_digest);
  expect(applied.status).toBe(0);
  expect(JSON.parse(applied.stdout).code).toBe('CLIENT_AUTH_REQUIRED');
  expect(JSON.parse(fs.readFileSync(path.join(config, '.claude.json'), 'utf8')).mcpServers['qoopia_' + connection.replaceAll('-', '')])
    .toEqual({ type: 'http', url: 'https://a.example/mcp/c/' + connection });
  expect(tree(home)).toEqual([]);
}, 20_000);

test('start and owner-login before install name the install command instead of a raw ENOENT', () => {
  for (const command of ['start', 'owner-login']) {
    const result = entry(command, '--root', root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Qoopia is not installed (INSTALL_REQUIRED). Run: qoopia install --commit');
    expect(result.stderr).not.toContain('ENOENT');
  }
  expect(fs.existsSync(root)).toBe(false);
}, 20_000);

// An installed, signed test-fixture bundle whose `qoopia` is this Bun: the installed-bundle
// dispatch then runs this source in-process, without compiling a release binary.
function installedSourceBundle(instance: string, port: number) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), trust = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const stage = path.join(outer, 'stage');
  privateDirectory(stage);
  fs.copyFileSync(process.execPath, path.join(stage, 'qoopia'));
  fs.chmodSync(path.join(stage, 'qoopia'), 0o700);
  for (const file of ['assets/src/public/dashboard.html', 'assets/src/public/brand/dashboard.js', 'assets/migrations/037-skill-loop.sql', 'SBOM.json', 'THIRD-PARTY-NOTICES.txt',
    'assets/scripts/runtime/codex-seatbelt.py', `assets/native/owner-peer.${process.platform === 'darwin' ? 'dylib' : 'so'}`]) {
    privateDirectory(path.dirname(path.join(stage, file)));
    durableWrite(path.join(stage, file), 'fixture');
  }
  const raw = JSON.stringify({ format: 'qoopia-bundle/1', version: '5.0.0-test', horizon: 'QOOPIA-V-1', api_version: 1, build_sha: 'a'.repeat(40), source_digest: hash('fixture'),
    target: `${process.platform}-${process.arch}`, bun_version: Bun.version, schema_min: 32, schema_max: 37, signing: 'test-fixture', publisher_key_sha256: hash(trust),
    platform_signing: 'NOT_RUN', members: inventory(stage) });
  durableWrite(path.join(stage, 'manifest.json'), raw);
  durableWrite(path.join(stage, 'manifest.sig'), sign(null, Buffer.from(raw), privateKey));
  const digest = hash(raw), bundle = path.join(root, 'bundles', digest);
  privateDirectory(path.dirname(bundle));
  fs.renameSync(stage, bundle);
  durableWrite(path.join(root, 'current.json'), JSON.stringify({ format: 'qoopia-installation/1', generation: 'generation-' + randomUUID(), bundle: digest, bundle_digest: digest, instance, port }));
  return async (...args: string[]) => {
    const child = Bun.spawn([path.join(bundle, 'qoopia'), '--define', 'QOOPIA_PINNED_KEY=' + JSON.stringify(trust), '--define', 'QOOPIA_BUILD_SHA="test"',
      path.resolve(import.meta.dir, '../src/delivery/entry.ts'), ...args], { stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, status };
  };
}

test('open reports the owner IPC failure when this installation already serves its port', async () => {
  const health = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ instance_id: 'installation-a' })); });
  await new Promise<void>(resolve => health.listen(0, '127.0.0.1', () => resolve()));
  const port = (health.address() as net.AddressInfo).port;
  try {
    const result = await installedSourceBundle('installation-a', port)('open', '--root', root, '--allow-test-fixture');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Qoopia is already running at http://127.0.0.1:${port}/dashboard`);
    expect(result.stderr).toContain('owner IPC failed');
    expect(result.stderr).not.toContain('qoopia-owner-');
  } finally { health.close(); }
}, 30_000);
