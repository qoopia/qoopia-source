/**
 * 5.0.23 (owner, after the Mac mini doctor said SERVER_UNAVAILABLE for two Codex sessions of 1.1 GB and 81 MB
 * while the server answered): the hook reads a transcript only from its cursor, sends the tail in bounded
 * portions with a timeout each, never holds the agent past its budget (the rest goes on in the background),
 * and doctor tells «no answer from /health» from «answers, but delivery is behind» from «all delivered».
 */
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { backgroundDrain, deliveryBacklog, drainMemoryBacklog, installMemoryClient, memoryClientsCheck, memoryServerAnswers, PORTION_BYTES, runMemoryHook } from '../src/delivery/memory-client.ts';
import { hash } from '../src/utils/fs.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { db } from '../src/db/connection.ts';
import { createWorkspace } from '../src/admin/workspaces.ts';
import { createAgent } from '../src/admin/agents.ts';
import { continuityEvent } from '../src/services/continuity.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const startDrain = backgroundDrain.start;
afterEach(() => { backgroundDrain.start = startDrain; });

/** A fake memory server that stores each message id once (the real one has a unique ingest_uuid index). */
function fixture(runtime: 'claude_code' | 'codex' = 'claude_code') {
  const root = fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-upload-')), home = path.join(root, 'home');
  const logs = path.join(home, runtime === 'codex' ? '.codex/sessions' : '.claude/projects/p');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const stored = new Map<string, string>(), requests: Array<{ event: string; ids: string[]; bytes: number }> = [];
  let delay = (_n: number) => 0;
  const server = Bun.serve({ port: 0, idleTimeout: 60, async fetch(req) {
    if (new URL(req.url).pathname === '/memory/canon') return new Response('', { status: 404 });
    const body = await req.text(), event = JSON.parse(body);
    requests.push({ event: event.event, ids: event.messages.map((m: any) => m.id), bytes: body.length });
    const wait = delay(requests.length); if (wait) await Bun.sleep(wait);
    for (const m of event.messages) if (!stored.has(m.id)) stored.set(m.id, m.content);
    return Response.json({ accepted: event.messages.map((m: any) => m.id), session_id: event.session_id, tail: [] });
  } });
  installMemoryClient({ format: 'qoopia-memory-connection/1', url: `http://127.0.0.1:${server.port}`, agent_id: 'fixture', key: 'q_fixturekey', runtime }, root, process.execPath, home);
  cleanup.push(() => { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'memory-clients', runtime, 'connection.json'), cursors = path.join(root, 'memory-clients', runtime, 'cursors');
  return { root, home, logs, file, cursors, stored, requests, stop: () => server.stop(true), origin: `http://127.0.0.1:${server.port}`, setDelay: (f: (n: number) => number) => { delay = f; } };
}
const turn = (i: number, size = 10_000) => JSON.stringify({ type: 'user', uuid: 'u' + i, message: { role: 'user', content: `ход ${i} ` + 'x'.repeat(size) } }) + '\n';

test('1. the hook reads a transcript of gigabytes only from its saved byte offset, never the whole file', async () => {
  const f = fixture(), transcript = path.join(f.logs, 'huge.jsonl');
  // A 3 GiB transcript: the delivered part is a sparse hole ending in a line break, the new turns follow it.
  const delivered = 3 * 1024 ** 3;
  fs.writeFileSync(transcript, ''); fs.truncateSync(transcript, delivered - 1); fs.appendFileSync(transcript, '\n');
  fs.appendFileSync(transcript, turn(1, 200) + turn(2, 200));
  const st = fs.statSync(transcript);
  fs.mkdirSync(f.cursors, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.cursors, hash(transcript) + '.json'), JSON.stringify({ file: transcript, session: 'claude_code:huge', project: '/p', cursor: delivered, part: 0, inode: st.dev + ':' + st.ino, last_sync: new Date().toISOString() }));
  const rss = process.memoryUsage().rss, started = performance.now();
  await runMemoryHook(f.file, { session_id: 'huge', cwd: '/p', transcript_path: transcript, hook_event_name: 'Stop' });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(process.memoryUsage().rss - rss).toBeLessThan(64 * 1024 * 1024);
  expect([...f.stored.keys()]).toEqual(['u1:0:0', 'u2:0:0']);
  expect(JSON.parse(fs.readFileSync(path.join(f.cursors, hash(transcript) + '.json'), 'utf8')).cursor).toBe(st.size);
  // Doctor counts what waits the same way: nothing.
  expect(deliveryBacklog(f.cursors)).toMatchObject({ sessions: 0, records: 0 });
});

test('2. a long tail goes in bounded portions; a portion cut off by its timeout is sent again under the same ids, nothing lost or doubled', async () => {
  const f = fixture(), transcript = path.join(f.logs, 'tail.jsonl');
  backgroundDrain.start = () => {};
  fs.writeFileSync(transcript, Array.from({ length: 60 }, (_, i) => turn(i)).join(''));
  // The second portion hangs past its 4 s timeout once.
  f.setDelay(n => n === 2 ? 4500 : 0);
  await runMemoryHook(f.file, { session_id: 'tail', cwd: '/p', transcript_path: transcript, hook_event_name: 'Stop' });
  const cut = f.requests[1]!.ids;
  const cursor = JSON.parse(fs.readFileSync(path.join(f.cursors, hash(transcript) + '.json'), 'utf8'));
  expect(cursor.error).toContain('timed out');
  // The cursor stopped after the first, acknowledged portion: the hook never moved past what was not confirmed.
  expect(cursor.cursor).toBe(Buffer.byteLength(Array.from({ length: f.requests[0]!.ids.length }, (_, i) => turn(i)).join('')));
  f.setDelay(() => 0);
  await drainMemoryBacklog(f.file);
  // The cut-off portion went again with the very same ids; every turn is stored exactly once.
  expect(f.requests.slice(2).some(r => JSON.stringify(r.ids) === JSON.stringify(cut))).toBe(true);
  expect(f.stored.size).toBe(60);
  expect([...f.stored.keys()].sort()).toEqual(Array.from({ length: 60 }, (_, i) => `u${i}:0:0`).sort());
  for (const r of f.requests) expect(r.bytes).toBeLessThan(PORTION_BYTES + 4096);
  expect(f.requests.length).toBeGreaterThan(4);
  const after = JSON.parse(fs.readFileSync(path.join(f.cursors, hash(transcript) + '.json'), 'utf8'));
  expect(after.cursor).toBe(fs.statSync(transcript).size); expect(after.error).toBeUndefined();
});

test('2b. a session end is told with the last portion only, so earlier portions do not close the session too early', async () => {
  const f = fixture(), transcript = path.join(f.logs, 'end.jsonl');
  fs.writeFileSync(transcript, Array.from({ length: 30 }, (_, i) => turn(i)).join(''));
  await runMemoryHook(f.file, { session_id: 'end', cwd: '/p', transcript_path: transcript, hook_event_name: 'SessionEnd' });
  const events = f.requests.map(r => r.event);
  expect(events.length).toBeGreaterThan(1);
  expect(events.at(-1)).toBe('end'); expect(events.slice(0, -1).every(e => e === 'progress')).toBe(true);
  expect(f.stored.size).toBe(30);
});

test('3. the hook returns inside its budget on a slow server; the rest waits on this computer and goes on in the background', async () => {
  const f = fixture(), transcript = path.join(f.logs, 'slow.jsonl'), started: string[] = [];
  backgroundDrain.start = config => { started.push(config); };
  fs.writeFileSync(transcript, Array.from({ length: 120 }, (_, i) => turn(i)).join(''));
  f.setDelay(() => 1500);
  const t0 = performance.now();
  await runMemoryHook(f.file, { session_id: 'slow', cwd: '/p', transcript_path: transcript, hook_event_name: 'Stop' });
  expect(performance.now() - t0).toBeLessThan(5600);
  expect(started).toEqual([f.file]);
  const waiting = deliveryBacklog(f.cursors);
  expect(waiting.sessions).toBe(1); expect(waiting.records).toBeGreaterThan(0);
  // The background drain (here run in place, with a faster server) sends the rest; the hook's portions are not repeated.
  f.setDelay(() => 0);
  expect(await drainMemoryBacklog(f.file)).toMatchObject({ status: 'DRAINED', sessions: 1, complete: 1 });
  expect(f.stored.size).toBe(120); expect(deliveryBacklog(f.cursors).sessions).toBe(0);
});

test('3c. an ended session no hook runs for any more is drained in the background from the next session start, and stays ended', async () => {
  const f = fixture(), transcript = path.join(f.logs, 'ended.jsonl'), started: string[] = [];
  backgroundDrain.start = config => { started.push(config); };
  fs.writeFileSync(transcript, turn(0));
  await runMemoryHook(f.file, { session_id: 'ended', cwd: '/p', transcript_path: transcript, hook_event_name: 'SessionEnd' });
  // Its transcript grew after the last delivery (a cut-off tail), far beyond three portions.
  fs.appendFileSync(transcript, Array.from({ length: 80 }, (_, i) => turn(i + 1)).join(''));
  fs.writeFileSync(path.join(f.logs, 'next.jsonl'), '');
  await runMemoryHook(f.file, { session_id: 'next', cwd: '/p', transcript_path: path.join(f.logs, 'next.jsonl'), hook_event_name: 'SessionStart' });
  expect(started).toEqual([f.file]);
  await drainMemoryBacklog(f.file);
  expect(f.stored.size).toBe(81);
  // Every portion of the ended session but its last says progress; the last says end again.
  const ended = f.requests.filter(r => r.ids.some(id => /^u\d+:/.test(id)));
  expect(ended.at(-1)!.event).toBe('end'); expect(ended.slice(1, -1).every(r => r.event === 'progress')).toBe(true);
});

test('3d. the background drain leaves the server at least half its time: it waits as long as each portion took', async () => {
  const f = fixture(), transcript = path.join(f.logs, 'paced.jsonl'), starts: number[] = [];
  backgroundDrain.start = () => {};
  // An ended session whose whole transcript still waits (a hook registered it, then the server was away).
  expect(await drainMemoryBacklog(f.file)).toMatchObject({ sessions: 0 });
  fs.writeFileSync(transcript, Array.from({ length: 50 }, (_, i) => turn(i)).join(''));
  const st = fs.statSync(transcript); fs.mkdirSync(f.cursors, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.cursors, hash(transcript) + '.json'), JSON.stringify({ file: transcript, session: 'claude_code:paced', project: '/p', cursor: 0, part: 0, inode: st.dev + ':' + st.ino, closed: true }));
  f.setDelay(() => { starts.push(Date.now()); return 400; });
  await drainMemoryBacklog(f.file);
  expect(f.stored.size).toBe(50); expect(starts.length).toBeGreaterThan(3);
  // Each portion takes 400 ms on the server; the next one starts no sooner than 400 ms after it ended.
  for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(780);
});

test('3b. turns captured from hook payloads wait on this computer only with secrets removed', async () => {
  const f = fixture('codex');
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  // A Codex thread without a transcript: its turns come from the hook payloads and wait in its cursor file.
  const hook = { session_id: 'desktop', cwd: '/p', transcript_path: null, turn_id: 't1' };
  backgroundDrain.start = () => {}; f.stop();
  await runMemoryHook(f.file, { ...hook, hook_event_name: 'UserPromptSubmit', prompt: 'deploy with ' + secret });
  await runMemoryHook(f.file, { ...hook, hook_event_name: 'Stop', last_assistant_message: 'done' });
  const cursorFile = fs.readdirSync(f.cursors).find(n => n.endsWith('.json'))!;
  const text = fs.readFileSync(path.join(f.cursors, cursorFile), 'utf8');
  expect(text).not.toContain(secret); expect(text).toContain('deploy with [REDACTED');
});

test('4. doctor: no answer from /health, answers but delivery is behind (records, bytes, since), or everything delivered', async () => {
  const f = fixture(), transcript = path.join(f.logs, 'doctor.jsonl');
  backgroundDrain.start = () => {};
  fs.writeFileSync(transcript, Array.from({ length: 40 }, (_, i) => turn(i)).join(''));
  f.setDelay(n => n === 1 ? 4500 : 0);
  await runMemoryHook(f.file, { session_id: 'doctor', cwd: '/p', transcript_path: transcript, hook_event_name: 'Stop' });
  // Without asking the server, a timed-out portion still reads as an outage (doctor offline, as before).
  expect(memoryClientsCheck(f.root, f.home)).toMatchObject({ status: 'fail', reason: 'SERVER_UNAVAILABLE' });
  // The server answers /health: it is a delay, told with how much waits and since when.
  const answers = await memoryServerAnswers(f.root, async () => 'reachable');
  expect(answers).toEqual({ [f.origin]: true });
  const behind = memoryClientsCheck(f.root, f.home, answers);
  expect(behind).toMatchObject({ status: 'warn', reason: 'CATCHING_UP', runtimes: [{ mode: 'catching_up', waiting: { sessions: 1 } }] });
  expect(behind.action).toMatch(/^Qoopia answers, but delivery from this computer is behind: 1 session, 40 records \(\d+ KB\) wait on this computer since /);
  // No answer from /health is the outage, whatever the cursors say.
  const down = memoryClientsCheck(f.root, f.home, await memoryServerAnswers(f.root, async () => 'unreachable'));
  expect(down).toMatchObject({ status: 'fail', reason: 'SERVER_UNAVAILABLE', runtimes: [{ mode: 'offline' }] });
  expect(down.action).toContain(`did not answer at ${f.origin}/health`);
  // An address answering as something else is not «no answer».
  expect(await memoryServerAnswers(f.root, async () => 'not_qoopia')).toEqual({});
  await drainMemoryBacklog(f.file);
  // A transcript of another profile ran these hooks once: it can never be sent from this link, so it does not wait here.
  const foreign = path.join(f.root, 'other-profile.jsonl'); fs.writeFileSync(foreign, turn(1));
  fs.writeFileSync(path.join(f.cursors, 'foreign.json'), JSON.stringify({ file: foreign, session: 'claude_code:foreign', project: '/p', cursor: 0, part: 0, error: 'Unrecognized native transcript path' }));
  expect(memoryClientsCheck(f.root, f.home, answers)).toMatchObject({ reason: 'FOREIGN_PROFILE', runtimes: [{ waiting: { sessions: 0 } }] });
  fs.rmSync(path.join(f.cursors, 'foreign.json'));
  const done = memoryClientsCheck(f.root, f.home, answers);
  expect(done).toMatchObject({ status: 'pass', reason: 'DELIVERING', runtimes: [{ mode: 'current', waiting: { sessions: 0 } }] });
  expect(done.action).toBe('No repair needed: everything is delivered.');
});

test('the server stores a re-sent portion once: message ids are the idempotency key', () => {
  runMigrations();
  const w = createWorkspace({ name: 'Upload 523', slug: 'upload-523' }), agent = createAgent({ name: 'upload-agent', workspaceSlug: w.slug }).id;
  const portion = { session_id: 'codex:resend', project: '/p', runtime: 'codex', event: 'progress', messages: [{ id: 'r1:0', role: 'user', content: 'первый' }, { id: 'r2:0', role: 'assistant', content: 'второй' }] };
  continuityEvent(w.id, agent, portion); continuityEvent(w.id, agent, portion);
  expect(db.query("SELECT COUNT(*) AS n FROM session_messages WHERE session_id='codex:resend'").get()).toEqual({ n: 2 });
});
