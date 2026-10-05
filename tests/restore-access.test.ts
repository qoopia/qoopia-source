import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { journalBundleFixture } from './helpers/p3-journal-bundle.ts';
import { Delivery, dataFile, type Current } from '../src/delivery/operations.ts';
import { durableWrite, privateDirectory } from '../src/utils/fs.ts';

const future = '2099-01-01T00:00:00.000Z';
function fixture() {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-restore-access-'))), root = path.join(outer, 'Same Mac Ж');
  privateDirectory(root);
  const source = ownerFixture(48), owner = source.owner, d0 = source.database;
  const instance = (d0.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  const bundle = journalBundleFixture(outer, 48); privateDirectory(path.join(root, 'bundles')); fs.renameSync(bundle.bundle, path.join(root, 'bundles', bundle.digest));
  const current: Current = { format: 'qoopia-installation/1', generation: 'generation-' + randomUUID(), bundle: bundle.digest, bundle_digest: bundle.digest, instance, port: 3737 };
  const file = dataFile(root, current); privateDirectory(path.dirname(file)); durableWrite(file, d0.serialize()); d0.close(); durableWrite(path.join(root, 'current.json'), JSON.stringify(current));
  const db = new Database(file), ws = owner.workspace_id;
  const agent = (id: string, key: string) => db.query("INSERT INTO agents(id,workspace_id,name,api_key_hash) VALUES (?,?,?,?)").run(id, ws, id + ' client', key);
  const client = (id: string, agentId: string) => db.query("INSERT INTO oauth_clients(id,name,agent_id,client_secret_hash,workspace_id) VALUES (?,?,?,?,?)").run(id, id, agentId, 'secret-' + id, ws);
  const token = (hash: string, clientId: string, agentId: string) => db.query("INSERT INTO oauth_tokens(token_hash,client_id,agent_id,workspace_id,token_type,expires_at) VALUES (?,?,?,?,'refresh',?)").run(hash, clientId, agentId, ws, future);
  const connection = (id: string, agentId: string, surface: string) => db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES (?,?,?,?,?,'read_write',?,'verified','h',?,?)`).run(id, ws, owner.agent_id, agentId, surface, id, future, new Date().toISOString());
  agent('claude', 'key-claude'); client('claude-app', 'claude'); token('refresh-1', 'claude-app', 'claude'); connection('c-claude', 'claude', 'claude_ai');
  agent('codex', 'key-codex-old');
  // Granted before the backup, withdrawn after it (below): steward role, old skill API, shared context, automatic memory.
  db.query("UPDATE agents SET type='steward',legacy_skill_access=1 WHERE id='codex'").run();
  agent('telegram', 'key-telegram'); client('telegram-app', 'telegram'); token('refresh-tg', 'telegram-app', 'telegram');
  db.query(`INSERT INTO agent_pairings(id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,code_digest,name,profile,principal_kind,runtime_id,expires_at_ms,policy_epoch)
    VALUES ('pairing-1',?,?,?,1,1,'digest-1','pairing','memory-worker','agent','runtime-1',?,1)`).run(ws, owner.agent_id, instance, Date.now() + 86_400_000);
  db.close();
  const delivery = new Delivery(root, bundle.trust, true, () => {}), backup = path.join(outer, 'backup'); delivery.backup(backup);
  // After the backup: Claude refreshed (rotation), the Codex key was rotated, Telegram was disconnected,
  // the pairing revoked, and ChatGPT was connected.
  const after = new Database(file);
  after.query("UPDATE oauth_tokens SET revoked=1 WHERE token_hash='refresh-1'").run();
  after.query("INSERT INTO oauth_tokens(token_hash,client_id,agent_id,workspace_id,token_type,expires_at) VALUES ('refresh-2','claude-app','claude',?,'refresh',?)").run(ws, future);
  after.query("UPDATE agents SET api_key_hash='key-codex-new' WHERE id='codex'").run();
  after.query("UPDATE agents SET authority_profile='memory-reader' WHERE id='claude'").run();
  after.query("UPDATE agents SET active=0 WHERE id='telegram'").run();after.query("UPDATE oauth_tokens SET revoked=1 WHERE token_hash='refresh-tg'").run();
  after.query("UPDATE agent_pairings SET revoked_at_ms=42 WHERE id='pairing-1'").run();
  after.query("UPDATE agents SET type='standard',legacy_skill_access=0 WHERE id='codex'").run();
  after.query("UPDATE agents SET metadata=json_set(metadata,'$.shared_context',json('false')),memory_mode='manual',memory_mode_revision=1 WHERE id='claude'").run();
  after.query("INSERT INTO agents(id,workspace_id,name,api_key_hash) VALUES ('chatgpt',?,'chatgpt client','key-chatgpt')").run(ws);
  after.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES ('c-chatgpt',?,?,'chatgpt','chatgpt','read_write','c-chatgpt','verified','h',?,?)`).run(ws, owner.agent_id, future, new Date().toISOString());
  after.close();
  return { outer, root, delivery, backup, trust: bundle.trust, cleanup: () => fs.rmSync(outer, { recursive: true, force: true }) };
}

test('same-machine restore keeps untouched clients working and re-applies every revocation made after the backup', () => {
  const f = fixture(); try {
    const result = f.delivery.restore(f.backup), d = new Database(dataFile(f.root, result.current), { readonly: true });
    const agent = (id: string) => d.query('SELECT api_key_hash,active FROM agents WHERE id=?').get(id) as {api_key_hash:string;active:number}|null;
    const revoked = (hash: string) => (d.query('SELECT revoked FROM oauth_tokens WHERE token_hash=?').get(hash) as {revoked:number}|null)?.revoked;
    // Claude keeps working: its key, and the refresh token issued after the backup.
    expect(agent('claude')).toEqual({ api_key_hash: 'key-claude', active: 1 });expect(revoked('refresh-2')).toBe(0);expect(revoked('refresh-1')).toBe(1);
    // The key rotated after the backup does not come back; the current one works.
    expect(agent('codex')!.api_key_hash).toBe('key-codex-new');
    // A role lowered after the backup stays lowered.
    expect(d.query("SELECT authority_profile FROM agents WHERE id='claude'").get()).toEqual({ authority_profile: 'memory-reader' });
    // Disconnected after the backup stays disconnected.
    expect(agent('telegram')!.active).toBe(0);expect(revoked('refresh-tg')).toBe(1);
    expect(d.query("SELECT revoked_at_ms FROM agent_pairings WHERE id='pairing-1'").get()).toEqual({ revoked_at_ms: 42 });
    d.close();
    expect(result.live_access).toStartWith('kept');
    expect(result.reconnect).toEqual([{ agent_id: 'chatgpt', name: 'chatgpt client', surface: 'chatgpt', reason: 'connected after the backup was taken: connect it again' }]);
  } finally { f.cleanup(); }
});

test('new-machine restore still resets all client access', () => {
  const f = fixture(); try {
    const target = new Delivery(path.join(f.outer, 'New Mac'), f.trust, true, () => {});
    const restored = target.restoreNew(f.backup, path.join(f.root, 'bundles', fs.readdirSync(path.join(f.root, 'bundles'))[0]!), 4141);
    const d = new Database(dataFile(target.root, restored.current), { readonly: true });
    expect((d.query("SELECT api_key_hash FROM agents WHERE id='claude'").get() as {api_key_hash:string}).api_key_hash).not.toBe('key-claude');
    expect(d.query('SELECT count(*) n FROM oauth_tokens WHERE revoked=0').get()).toEqual({ n: 0 });
    d.close();
  } finally { f.cleanup(); }
});

test('same-machine restore keeps a steward demotion, a withdrawn skill API, shared context off and manual memory made after the backup', () => {
  const f = fixture(); try {
    const result = f.delivery.restore(f.backup), d = new Database(dataFile(f.root, result.current), { readonly: true });
    expect(d.query("SELECT type,legacy_skill_access FROM agents WHERE id='codex'").get()).toEqual({ type: 'standard', legacy_skill_access: 0 });
    expect(d.query("SELECT json_extract(metadata,'$.shared_context') shared,memory_mode FROM agents WHERE id='claude'").get()).toEqual({ shared: 0, memory_mode: 'manual' });
    d.close();
  } finally { f.cleanup(); }
});
