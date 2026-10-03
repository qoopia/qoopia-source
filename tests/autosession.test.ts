import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { p1Database } from './helpers/p1-fixtures.ts';

// Legacy Phase 7a autosession stack: the standalone tailer daemon and its admin allowlist CLI.
// Everything runs against temp paths and a stub /ingest server, never ~/.qoopia or port 3737.

// Generous: the release image verify stage runs this inside a loaded full suite (F-292).
async function until(condition: () => boolean, what: string, ms = 25_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await Bun.sleep(25);
  }
}
const line = (uuid: string, type: string, content: unknown, cwd = '/work/proj') =>
  JSON.stringify({ type, uuid, sessionId: 'session-1', timestamp: '2026-10-02T00:00:00.000Z', cwd, message: { role: type, content } }) + '\n';

test('tailer posts each attributed dialogue line once, retries failures and resumes from persisted cursors', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-'))), projects = path.join(directory, 'projects');
  const project = path.join(projects, '-work-proj'), cursors = path.join(directory, 'state', 'cursors.json'), key = path.join(directory, 'ingest.key');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.writeFileSync(key, 'q_fixture-ingest-key\n', { mode: 0o600 });
  const posts: { status: number; auth: string | null; body: Record<string, unknown> }[] = [], failOnce = new Set(['u2']);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/ingest/allowlist') return Response.json([
      { cwd_prefix: '/work/proj', agent_id: 'agent-proj', autosession_enabled: 1 },
      { cwd_prefix: '/work/paused', agent_id: 'agent-paused', autosession_enabled: 0 }]);
    const body = await request.json() as Record<string, unknown>, status = failOnce.delete(String(body.uuid)) ? 503 : 200;
    posts.push({ status, auth: request.headers.get('authorization'), body });
    return Response.json({ ok: status === 200 }, { status });
  } });
  const delivered = () => posts.filter(post => post.status === 200).map(post => post.body.uuid);
  const file = path.join(project, 'session.jsonl');
  fs.writeFileSync(file, [
    line('u1', 'user', 'hello from the owner'),
    line('u2', 'assistant', [{ type: 'text', text: 'assistant reply' }]),
    line('u3', 'assistant', [{ type: 'tool_use', name: 'mcp__plugin_telegram_telegram__reply', input: { text: 'sent to telegram' } }]),
    line('u4', 'assistant', [{ type: 'tool_use', name: 'note_create', input: { text: 'not dialogue' } }]),
    line('u5', 'user', 'password = hunter2-hunter2'),
    JSON.stringify({ type: 'summary', summary: 'not a turn' }) + '\n',
    line('u7', 'user', 'paused project', '/work/paused'),
    line('u8', 'user', 'nested project directory', '/work/proj/sub'),
  ].join('') + line('u9', 'user', 'completed later').trimEnd());
  const start = () => Bun.spawn([process.execPath, 'src/ingest/tailer.ts'], { cwd: path.resolve(import.meta.dir, '..'), stdout: 'ignore', stderr: 'ignore',
    env: { PATH: process.env.PATH, HOME: path.join(directory, 'home'), TMPDIR: os.tmpdir(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      QOOPIA_URL: `http://127.0.0.1:${server.port}`, QOOPIA_INGEST_KEY_PATH: key, CLAUDE_PROJECTS_DIR: projects, QOOPIA_CURSORS_PATH: cursors } });
  let tailer = start();
  try {
    // u2 fails once: the cursor stops before it and the bounded sweep retries; nothing after it is skipped.
    await until(() => delivered().length === 4, 'first delivery');
    expect(delivered()).toEqual(['u1', 'u2', 'u3', 'u8']);
    expect(posts.map(post => post.body.uuid)).toEqual(['u1', 'u2', 'u2', 'u3', 'u8']);
    expect(posts.every(post => post.auth === 'Bearer q_fixture-ingest-key')).toBe(true);
    expect(posts[0]!.body).toEqual({ attributed_agent_id: 'agent-proj', session_id: 'session-1', uuid: 'u1', role: 'user',
      content: 'hello from the owner', timestamp: '2026-10-02T00:00:00.000Z', cwd: '/work/proj', metadata: {} });
    expect(posts[3]!.body).toMatchObject({ role: 'assistant', content: 'sent to telegram', metadata: { tool: 'mcp__plugin_telegram_telegram__reply' } });
    // The incomplete record is delivered once its newline arrives; a new session file is discovered.
    fs.appendFileSync(file, '\n');
    fs.writeFileSync(path.join(project, 'second.jsonl'), line('s1', 'user', 'second session'));
    await until(() => delivered().length === 6, 'completed and discovered records');
    expect(delivered().slice(4).sort()).toEqual(['s1', 'u9']);
    // The stub records a post before the tailer reads the 200 and advances its cursor;
    // wait for the acknowledgement to be persisted instead of racing SIGTERM against it.
    const acknowledged = { [file]: fs.statSync(file).size, [path.join(project, 'second.jsonl')]: fs.statSync(path.join(project, 'second.jsonl')).size };
    const persisted = () => { try { return JSON.parse(fs.readFileSync(cursors, 'utf8')); } catch { return null; } };
    await until(() => Bun.deepEquals(persisted(), acknowledged), 'persisted cursors');
    tailer.kill('SIGTERM');
    expect(await tailer.exited).toBe(0);
    expect(persisted()).toEqual(acknowledged);
    // A restart resumes from the acknowledged cursors: only the new record is posted.
    const before = posts.length;
    tailer = start();
    fs.appendFileSync(file, line('u10', 'user', 'after restart'));
    await until(() => posts.length > before, 'post after restart');
    await Bun.sleep(300);
    expect(posts.slice(before).map(post => post.body.uuid)).toEqual(['u10']);
  } finally {
    tailer.kill('SIGKILL');
    await tailer.exited;
    server.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);

// Temp projects dir with the given session files, a stub /ingest server whose POST status
// is chosen per uuid, and a running tailer whose stderr is collected until stop().
function tailerFixture(files: Record<string, string>, status: (uuid: string) => number, allowlistStatus: (request: number) => number = () => 200) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-'))), projects = path.join(directory, 'projects');
  const project = path.join(projects, '-work-proj'), cursors = path.join(directory, 'cursors.json'), key = path.join(directory, 'ingest.key');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.writeFileSync(key, 'q_fixture-ingest-key\n', { mode: 0o600 });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(project, name), body);
  const posts: string[] = [];
  let allowlistGets = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/ingest/allowlist') {
      const code = allowlistStatus(++allowlistGets);
      if (code !== 200) return Response.json({ error: 'rate_limited' }, { status: code, headers: { 'retry-after': '1' } });
      return Response.json([{ cwd_prefix: '/work/proj', agent_id: 'agent-proj', autosession_enabled: 1 }]);
    }
    const uuid = String(((await request.json()) as { uuid: string }).uuid);
    posts.push(uuid);
    return Response.json({}, { status: status(uuid) });
  } });
  const tailer = Bun.spawn([process.execPath, 'src/ingest/tailer.ts'], { cwd: path.resolve(import.meta.dir, '..'), stdout: 'ignore', stderr: 'pipe',
    env: { PATH: process.env.PATH, HOME: path.join(directory, 'home'), TMPDIR: os.tmpdir(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      QOOPIA_URL: `http://127.0.0.1:${server.port}`, QOOPIA_INGEST_KEY_PATH: key, CLAUDE_PROJECTS_DIR: projects, QOOPIA_CURSORS_PATH: cursors } });
  const stderr = new Response(tailer.stderr).text();
  return {
    project, cursors, posts, allowlistGets: () => allowlistGets,
    cursor: (name: string) => { try { return JSON.parse(fs.readFileSync(cursors, 'utf8'))[path.join(project, name)] as number; } catch { return undefined; } },
    async stop() {
      tailer.kill('SIGKILL');
      await tailer.exited;
      server.stop(true);
      fs.rmSync(directory, { recursive: true, force: true });
      return stderr;
    },
  };
}

test('tailer skips records the server refuses for good or that exceed the read window, and retries transient failures', async () => {
  const refused: Record<string, number> = { r400: 400, r404: 404, r409: 409, r413: 413 }, transient: Record<string, number> = { t403: 403, t429: 429, t500: 500 };
  const marked = (uuid: string) => line(uuid, 'user', 'CONTENT-OF-' + uuid);
  const tail = line('f0', 'user', 'z'.repeat(5 * 1024 * 1024)).trimEnd();
  const files = {
    'refused.jsonl': [marked('a1'), ...Object.keys(refused).map(marked), marked('a2')].join(''),
    'transient.jsonl': marked('b1') + Object.keys(transient).map(marked).join('') + marked('b2'),
    'oversized.jsonl': line('big', 'user', 'y'.repeat(5 * 1024 * 1024)) + marked('c1'),
    'incomplete.jsonl': marked('d1') + tail,
  };
  const fixture = tailerFixture(files, uuid => refused[uuid] ?? transient[uuid] ?? 200);
  const size = (name: string) => fs.statSync(path.join(fixture.project, name)).size;
  let stderr = '';
  try {
    await until(() => ['a2', 'b1', 'c1', 'd1'].every(uuid => fixture.posts.includes(uuid)), 'deliveries around refused and oversized records');
    // A transient failure keeps its record (and everything after it) pending and is retried.
    await until(() => fixture.posts.filter(uuid => uuid === 't403').length >= 2, 'retry of a transient failure');
    expect(fixture.posts).not.toContain('b2');
    for (const uuid of Object.keys(refused)) expect(fixture.posts.filter(post => post === uuid)).toHaveLength(1);
    await until(() => fixture.cursor('refused.jsonl') === size('refused.jsonl') && fixture.cursor('oversized.jsonl') === size('oversized.jsonl'), 'cursors past skipped records');
    expect(fixture.cursor('transient.jsonl')).toBe(Buffer.byteLength(marked('b1')));
    // An oversized record still being written is never acknowledged; once complete it is skipped.
    expect(fixture.cursor('incomplete.jsonl')).toBe(Buffer.byteLength(marked('d1')));
    fs.appendFileSync(path.join(fixture.project, 'incomplete.jsonl'), '\n' + marked('d2'));
    await until(() => fixture.posts.includes('d2'), 'record after a completed oversized one');
    expect(fixture.posts).not.toContain('f0');
  } finally { stderr = await fixture.stop(); }
  // Skips are logged by uuid and status, never with the message text.
  for (const uuid of Object.keys(refused)) expect(stderr).toContain(uuid);
  expect(stderr).not.toContain('CONTENT-OF-');
}, 40_000);

test('tailer with hundreds of session files shares one allowlist request, backs off on 429 and stays quiet when idle', async () => {
  const count = 300, files = Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}.jsonl`, line(`m${i}`, 'user', 'hello ' + i)]));
  const fixture = tailerFixture(files, () => 200, request => request === 1 ? 429 : 200);
  try {
    await until(() => fixture.posts.length === count, 'every session delivered', 15_000);
    // One rate-limited request, one after its Retry-After: not one per file.
    expect(fixture.allowlistGets()).toBe(2);
    await until(() => Object.keys(files).every(name => fixture.cursor(name) === Buffer.byteLength(files[name]!)), 'persisted cursors');
    const written = fs.statSync(fixture.cursors).mtimeMs;
    await Bun.sleep(4_500); // two idle sweeps
    expect(fs.statSync(fixture.cursors).mtimeMs).toBe(written);
    expect(fixture.allowlistGets()).toBe(2);
    expect(fixture.posts).toHaveLength(count);
    // A deleted session file is forgotten, cursor included.
    fs.unlinkSync(path.join(fixture.project, 's0.jsonl'));
    await until(() => fixture.cursor('s0.jsonl') === undefined, 'forgotten cursor');
  } finally { await fixture.stop(); }
}, 40_000);

test('admin CLI registers, lists, pauses and resumes the autosession allowlist', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-'))), data = path.join(directory, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const fixture = p1Database(48), owner = bootstrapOwner(fixture, 'Tailer owner', 'Tailer workspace');
  const slug = (fixture.query('SELECT slug FROM workspaces WHERE id=?').get(owner.workspace_id) as { slug: string }).slug;
  fs.writeFileSync(path.join(data, 'qoopia.db'), fixture.serialize());
  fixture.close();
  const admin = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', 'admin', ...args, '--workspace', slug], { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: path.join(directory, 'home'), TMPDIR: os.tmpdir(), NODE_ENV: 'test', QOOPIA_ROOT: directory, QOOPIA_LOG_LEVEL: 'error' } });
  const allowlist = () => {
    const database = new Database(path.join(data, 'qoopia.db'), { readonly: true });
    try { return database.query('SELECT agent_id,cwd_prefix,autosession_enabled FROM claude_code_agents ORDER BY cwd_prefix').all(); }
    finally { database.close(); }
  };
  try {
    const registered = admin('register-claude-agent', 'Tailer owner', '--cwd-prefix', '/work/proj');
    expect(registered.status).toBe(0);
    expect(registered.stdout).toContain("Registered Claude Code agent 'Tailer owner' → cwd_prefix: /work/proj");
    expect(allowlist()).toEqual([{ agent_id: owner.agent_id, cwd_prefix: '/work/proj', autosession_enabled: 1 }]);
    const duplicate = admin('register-claude-agent', 'Tailer owner', '--cwd-prefix', '/work/proj');
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("cwd_prefix '/work/proj' already registered");
    const unknown = admin('register-claude-agent', 'Missing agent', '--cwd-prefix', '/work/other');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("active agent 'Missing agent' not found");
    expect(admin('disable-autosession', '--cwd-prefix', '/work/proj').status).toBe(0);
    expect(allowlist()).toEqual([{ agent_id: owner.agent_id, cwd_prefix: '/work/proj', autosession_enabled: 0 }]);
    expect(admin('list-claude-agents').stdout).toMatch(/Tailer owner +\/work\/proj +autosession=off/);
    expect(admin('enable-autosession', '--cwd-prefix', '/work/proj').status).toBe(0);
    expect(admin('list-claude-agents').stdout).toMatch(/autosession=on/);
    const missing = admin('enable-autosession', '--cwd-prefix', '/work/none');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("cwd_prefix '/work/none' not registered");
    expect(allowlist()).toHaveLength(1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
