import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, DB_PATH } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { bootstrapOwner, issuePairing, redeemPairing } from '../src/auth/pairings.ts';
import { installedRuntime } from '../src/delivery/installed-runtime.ts';
import { configureRuntime, entriesOf, RUNTIMES } from '../src/skills/loop.ts';
import { authorizeRun } from '../src/skills/runtime.ts';
import { bindManagedRoot } from '../src/skills/adapter.ts';
import { digest } from '../src/skills/commands.ts';
import { hash } from '../src/utils/fs.ts';
import { principalAuth } from './helpers/p1-fixtures.ts';
import { accepted, assigned } from './helpers/p2-fixtures.ts';

let outer: string, installation: string, owner: ReturnType<typeof bootstrapOwner>, databaseMode: number;
beforeEach(() => {
  runMigrations();
  // operator() requires the private (0600) installed database; restore the shared preload DB afterwards.
  databaseMode = fs.statSync(DB_PATH).mode & 0o777;
  fs.chmodSync(DB_PATH, 0o600);
  outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installed-runtime-')));
  installation = path.join(outer, 'installation');
  fs.mkdirSync(installation, { mode: 0o700 });
  const workspace = randomUUID();
  db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace, 'Installed runtime', workspace);
  owner = bootstrapOwner(db, 'Installed runtime owner', undefined, workspace);
});
afterEach(() => {
  fs.chmodSync(DB_PATH, databaseMode);
  fs.rmSync(outer, { recursive: true, force: true });
});

const bind = (managed_root: string) => installedRuntime('bind', {
  connection: { path: path.join(installation, 'connections', 'agent.json'), sha256: 'a'.repeat(64), instance: 'instance',
    workspace_id: owner.workspace_id, runtime_id: 'unregistered-runtime', agent_id: 'agent' },
  runtime_kind: 'claude_code', runtime_version: 'fixture', managed_root, expected_revision: 1,
}, installation, owner.agent_id);

test('managed root named ..x inside installation is refused', async () => {
  for (const inside of [installation, path.join(installation, 'tasks'), path.join(installation, '..x'), path.join(installation, '...'), path.join(installation, '..a', 'b')])
    await expect(bind(inside)).rejects.toThrow('Managed task root must be outside the installation');
  // Outside roots pass the containment check and reach the registration lookup.
  for (const outside of [path.join(outer, 'managed'), installation + 'x', '/var/tmp/qoopia-managed'])
    await expect(bind(outside)).rejects.toThrow('Runtime registration not found');
});

test('installed start, sync, audit and cleanup use the installed database and refuse a wrong trace hash', async () => {
  // loopFixture on the installed database: target and reporter principals, configured runtime, assigned skill.
  const auth = principalAuth(db, owner.agent_id);
  const pair = (profile: string, name: string, target_agent_id?: string) => redeemPairing(issuePairing(auth, { profile, name, runtime_id: 'claude_code',
    ...(target_agent_id ? { target_agent_id } : {}), expected_revision: 1, idempotency_key: randomUUID() }, db).one_time_code!, db);
  const target = pair('memory-worker', 'Runtime target'), reporter = pair('runtime-reporter', 'Reporter', target.data.agent_id);
  const runtimeId = target.data.runtime_registration_id;
  configureRuntime(auth, { runtime_id: runtimeId, runtime_kind: 'claude_code', runtime_version: RUNTIMES.claude_code.version, platform: 'darwin-arm64',
    expected_revision: 2, idempotency_key: randomUUID() }, db);
  const f = { database: db, owner, auth, target, reportAuth: principalAuth(db, reporter.data.agent_id), runtimeId };
  assigned(f, accepted(f));
  const managed = path.join(outer, 'managed');
  fs.mkdirSync(managed, { mode: 0o700 });
  bindManagedRoot(db, auth, runtimeId, managed);
  const run = (operation: string, input: unknown) => installedRuntime(operation, input, installation, owner.agent_id);
  const opened = await run('start', { runtime_id: runtimeId, native_session_ref: randomUUID(), qoopia_session_id: randomUUID() }) as { loadout_id: string };
  expect(await run('sync', { loadout_id: opened.loadout_id })).toMatchObject({ loadout_id: opened.loadout_id, replayed: true });
  const entry = entriesOf(db, opened.loadout_id)[0]!;
  const authorized = authorizeRun(f.reportAuth, { expected_revision: 0, idempotency_key: randomUUID(), loadout_id: opened.loadout_id, entry_id: entry.id,
    version_id: entry.version_id, projection_digest: entry.projection_digest, attempt_id: randomUUID(), environment_digest: digest('installed audit'),
    evaluator: { kind: 'json-artifacts/1', objective: 'CSV validation and summary', cases: [{ name: 'summary', path: 'summary.json', expected: { overall: 25 }, absent: [] }] } }, db);
  const trace = path.join(outer, 'trace.json');
  fs.writeFileSync(trace, '{"writes":[]}', { mode: 0o600 });
  const audit = (trace_digest: string) => run('audit', { run_id: authorized.data.run_id, outside_writes: 'none', method: 'os_write_trace', trace_file: trace, trace_digest });
  await expect(audit('0'.repeat(64))).rejects.toThrow('Audit trace hash mismatch');
  await expect(audit(hash(fs.readFileSync(trace)))).rejects.toThrow('No installed native execution for this audit');
  await expect(run('cleanup', { loadout_id: opened.loadout_id })).rejects.toThrow('Close or reconcile active/unknown runs');
  await expect(run('anything', {})).rejects.toThrow('Unsupported installed runtime operation');
});
