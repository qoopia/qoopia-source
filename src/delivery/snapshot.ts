import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readRecoveryOps, validateRecoveryOps, opsJournalError, OpsJournalError, opsFile, type OpsState, serializeOps } from './ops-state.ts';
import type { Database } from 'bun:sqlite';
import { openReadonlyDatabase, openWritableDatabase, assertDatabaseIntegrity } from '../db/sqlite.ts';
import { createVerifiedBackup, sha256File } from '../services/backup.ts';
import { computeLogicalDatabaseHash } from '../db/v4-migrations.ts';
import { hash, privateDirectory, durableWrite, durableCopyFile, readJson, readJsonBytes, MAX_JSON_BYTES, safePath, preflightSpace } from '../utils/fs.ts';
import { tableExists } from '../db/introspect.ts';

/** Schemas a unified snapshot can carry. One list: backup, retention and restore read it from here. */
const UNIFIED_SNAPSHOT_SCHEMAS=[37,38,39,40,41,42,43,44,45,46,47,48] as const;
export const unifiedSnapshotSchema=(schema:number)=>(UNIFIED_SNAPSHOT_SCHEMAS as readonly number[]).includes(schema);

export function inspectSnapshot(database: Database) {
  assertDatabaseIntegrity(database, 'Snapshot');
  const tables = new Set((database.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r => r.name));
  const schema = (database.query('SELECT max(version) n FROM schema_versions').get() as {n:number}).n;
  if (!unifiedSnapshotSchema(schema)) throw new Error(`Unified snapshot requires schema ${UNIFIED_SNAPSHOT_SCHEMAS.join(', ')}; use versioned source migration for 32/35`);
  const instance = (database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  let bytes = 0, packages = 0;
  for (const row of database.query('SELECT sha256,content,size FROM files').iterate() as IterableIterator<{sha256:string;content:Uint8Array;size:number}>) {
    if (!row.content || hash(row.content) !== row.sha256 || row.content.length !== row.size) throw new Error('Original file content missing or checksum mismatch');
    bytes += row.size;
  }
  for (const row of database.query('SELECT package_bytes,package_digest,status FROM skill_versions').iterate() as IterableIterator<{package_bytes:Uint8Array|null;package_digest:string|null;status:string}>) {
    if (row.package_digest && (!row.package_bytes || hash(row.package_bytes) !== row.package_digest)) throw new Error('Immutable package missing or checksum mismatch');
    if (row.status === 'sealed' && !row.package_digest) throw new Error('Sealed package missing');
    if (row.package_bytes) { bytes += row.package_bytes.length; packages++; }
  }
  for (const row of database.query('SELECT original_row,row_digest FROM migration_origins').iterate() as IterableIterator<{original_row:Uint8Array;row_digest:string}>) {
    if (hash(row.original_row) !== row.row_digest) throw new Error('Archived migration row checksum mismatch');
  }
  const count = (table: string) => (database.query(`SELECT count(*) n FROM "${table}"`).get() as {n:number}).n;
  const counts: Record<string,number> = {};
  for (const table of ['notes','sessions','files','skill_versions','skill_draft_revisions','skill_outcomes','workspace_owners','migration_origins','publisher_keys']) if (tables.has(table)) counts[table] = count(table);
  const publicKeys = tables.has('publisher_keys') ? count('publisher_keys') : 0;
  return { instance, schema, logical_hash: computeLogicalDatabaseHash(database), counts, packages, inline_bytes: bytes,
    ...(tables.has('bridge_identities')?{bridge_identity:{installations:count('bridge_identities'),private_keys:'included_in_private_database_snapshot',restore:'Stop the original installation before resuming the same bridge identity on a replacement'}}:{}),
    key_recovery: { public_trust_preserved: true, private_keys: 'not_custodied_by_qoopia', registered_public_keys: publicKeys,
      signing_continuity: publicKeys ? 'CONDITIONAL: external private recovery required' : 'no_registered_publisher', live_access: 'reissue_on_new_machine' } };
}
export function snapshotInfo(file: string) {
  safePath(file); const database = openReadonlyDatabase(file);
  try { return inspectSnapshot(database); } finally { database.close(); }
}
export function snapshotExtent(file: string) {
  const database = openReadonlyDatabase(safePath(file));
  try {
    return (database.query('PRAGMA page_count').get() as {page_count:number}).page_count *
      (database.query('PRAGMA page_size').get() as {page_size:number}).page_size;
  } finally { database.close(); }
}
export function backupUnified(source: string, output: string, expectedInstance?: string, operationsDir?: string) {
  safePath(source); if (fs.existsSync(output)) throw new Error('Backup destination must be new');
  const sourceInfo = snapshotInfo(source);
  if (expectedInstance && sourceInfo.instance !== expectedInstance) throw new Error('Backup instance mismatch');
  const operationsBytes = operationsDir ? Buffer.from(serializeOps(readRecoveryOps(operationsDir, sourceInfo.instance))) : undefined;
  // Use the current SQLite page extent for staging planning, with a separate
  // metadata allowance. This is not a reservation or a SQLite temporary-space quota.
  preflightSpace(output, [snapshotExtent(source), operationsBytes?.length ?? 0, MAX_JSON_BYTES]);
  privateDirectory(output);
  const snapshot = createVerifiedBackup({source, output:path.join(output,'snapshot.db')});
  fs.chmodSync(snapshot.output,0o600);
  const info = snapshotInfo(snapshot.output);
  if (info.instance !== sourceInfo.instance) throw new Error('Snapshot instance changed');
  if (operationsBytes) durableWrite(opsFile(output), operationsBytes);
  const manifest = { format:operationsBytes ? 'qoopia-backup/2' : 'qoopia-backup/1', data_scope:`complete-schema-${info.schema}-installation`, created_at:snapshot.created_at, sha256:snapshot.sha256, size:snapshot.size_bytes, ...info,
    ...(operationsBytes ? {operations: {sha256:hash(operationsBytes),size:operationsBytes.length}} : {}) };
  durableWrite(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
type BackupManifest = ReturnType<typeof backupUnified>;
/** One member list for verification, doctor and conservative rotation. */
export function backupMembers(root: string) {
  const m = readJson<BackupManifest>(path.join(root, 'manifest.json'));
  if (m.format !== 'qoopia-backup/1' && m.format !== 'qoopia-backup/2') throw new Error('Backup format or instance mismatch');
  const members = ['manifest.json', 'snapshot.db', ...(m.format === 'qoopia-backup/2' ? ['operations-status.json'] : [])].sort();
  if (JSON.stringify(fs.readdirSync(safePath(root)).sort()) !== JSON.stringify(members)) throw new Error('Backup members invalid');
  return members;
}
export function backupOperations(root: string, manifest: BackupManifest): OpsState | undefined {
  if (manifest.format === 'qoopia-backup/1') {
    if (manifest.operations !== undefined) throw new Error('Backup operations format mismatch');
    return undefined;
  }
  const record = manifest.operations;
  if (record && record.size > MAX_JSON_BYTES) throw new OpsJournalError('OPS_JOURNAL_TOO_LARGE');
  if (!record || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Backup operations checksum mismatch');
  let bytes: Buffer;
  try {
    const file = safePath(opsFile(root)), size = fs.statSync(file).size;
    if (size > MAX_JSON_BYTES) throw new OpsJournalError('OPS_JOURNAL_TOO_LARGE');
    if (size !== record.size) throw new OpsJournalError('OPS_JOURNAL_INVALID');
    bytes = readJsonBytes(file);
  } catch (error) { throw opsJournalError(error); }
  if (bytes.length !== record.size || hash(bytes) !== record.sha256) throw new Error('Backup operations checksum mismatch');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new OpsJournalError('OPS_JOURNAL_INVALID'); }
  return validateRecoveryOps(value, manifest.instance);
}
export function verifyBackup(root: string, expectedInstance?: string) {
  backupMembers(root);
  const m = readJson<BackupManifest>(path.join(root,'manifest.json'));
  if (expectedInstance && m.instance !== expectedInstance) throw new Error('Backup format or instance mismatch');
  backupOperations(root, m);
  const file = safePath(path.join(root,'snapshot.db'));
  if (fs.statSync(file).size !== m.size || sha256File(file) !== m.sha256) throw new Error('Backup checksum mismatch');
  // SQLite may create sidecars even for a readonly WAL header. Inspect only a private copy.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-verify-backup-'));
  try {
    const copy = path.join(scratch, 'snapshot.db');
    durableCopyFile(file, copy, m.size, m.sha256);
    const prepared = openWritableDatabase(copy);
    try {
      prepared.query('SELECT count(*) FROM sqlite_master').get();
      const actual = snapshotInfo(copy);
      if (JSON.stringify(actual) !== JSON.stringify({instance:m.instance,schema:m.schema,logical_hash:m.logical_hash,counts:m.counts,packages:m.packages,inline_bytes:m.inline_bytes,...(m.schema>=39?{bridge_identity:m.bridge_identity}:{}),key_recovery:m.key_recovery})) throw new Error('Backup inventory mismatch');
    } finally { prepared.close(); }
  } finally { fs.rmSync(scratch, {recursive:true,force:true}); }
  return m;
}
/** Resets every key, grant, pairing and native binding in a restored copy. Used for a new-machine copy, and
 * for a same-machine restore whose current database is unreadable (later revocations cannot be known).
 * No identity/grant promotion or original package edits. */
export function invalidateRestoredAccess(file: string) {
  const d = openWritableDatabase(file);
  try {
    d.transaction(() => {
      d.query('UPDATE agents SET api_key_hash=lower(hex(randomblob(32))),session_version=session_version+1,policy_epoch=policy_epoch+1').run();
      d.query('UPDATE oauth_tokens SET revoked=1').run();
      d.query('UPDATE agent_pairings SET revoked_at_ms=?').run(Date.now());
      d.query('UPDATE runtime_registrations SET managed_root=NULL,reporter_id=NULL,revision=revision+1').run();
      if(tableExists(d,'qoopia_agent_settings')) {
        d.query("UPDATE qoopia_agent_settings SET enabled=0,channel='dashboard',telegram_user_id=NULL,telegram_chat_id=NULL,telegram_username=NULL,telegram_verified=0").run();
        d.query('UPDATE qoopia_agent_conversations SET native_thread_id=NULL').run();
      }
      if(tableExists(d,'qoopia_telegram_channels')) {
        d.query("UPDATE qoopia_telegram_channels SET generation=lower(hex(randomblob(16))),pairing_code=NULL,pairing_expires=NULL,candidate_id=NULL,candidate_chat=NULL,candidate_name=NULL,paused=1,conversation_id=NULL").run();
        d.query("UPDATE qoopia_telegram_inbox SET state='cancelled' WHERE state IN ('queued','starting','running')").run();
        d.query("UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE state IN ('queued','sending')").run();
      }
    }).immediate();
    assertDatabaseIntegrity(d);
  } finally { d.close(); }
}

type AccessAgent = { id: string; name: string; api_key_hash: string; active: number; session_version: number; policy_epoch: number; tool_profile: string; principal_kind: string; authority_profile: string | null;
  type: string; legacy_skill_access: number; shared: number | null; memory_mode?: string; memory_mode_revision?: number; memory_mode_updated_at_ms?: number | null; memory_mode_actor_id?: string | null };
export type Reconnect = { agent_id: string; name: string; surface?: string; reason: string };
const TOOL_RANK: Record<string, number> = { 'read-only': 0, 'no-destructive': 1, full: 2 };
/** Same installation, same machine. The restored copy keeps its keys, grants and pairings, and every
 * revocation made after the backup is re-applied from the current database (`live`, read before it is
 * replaced): a revoked or deleted grant, a deactivated agent or a rotated key never comes back, and the
 * current keys and live OAuth tokens keep working. Both databases must be at the same schema.
 * Returns the clients that must reconnect, and why. */
export function carryAccessForward(file: string, liveFile: string): Reconnect[] {
  const live = openReadonlyDatabase(safePath(liveFile)), d = openWritableDatabase(safePath(file)), reconnect: Reconnect[] = [];
  try {
    const all = <T>(db: Database, sql: string) => db.query(sql).all() as T[];
    const has = (table: string) => tableExists(live, table) && tableExists(d, table);
    const columns = (table: string) => (d.query(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(c => c.name);
    const copy = (table: string, row: Record<string, unknown>) => { const names = columns(table).filter(name => name in row);
      d.query(`INSERT OR IGNORE INTO "${table}"(${names.map(n => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(n => row[n] as never)); };
    // Memory policy (schema 45+) is the owner's privacy decision: manual set after the backup stays manual.
    const memory = columns('agents').includes('memory_mode') ? ',memory_mode,memory_mode_revision,memory_mode_updated_at_ms,memory_mode_actor_id' : '';
    const agentSql = `SELECT id,name,api_key_hash,active,session_version,policy_epoch,tool_profile,principal_kind,authority_profile,type,legacy_skill_access,
      json_extract(metadata,'$.shared_context') shared${memory} FROM agents`;
    const current = new Map(all<AccessAgent>(live, agentSql).map(a => [a.id, a])), restored = new Map(all<AccessAgent>(d, agentSql).map(a => [a.id, a]));
    const surfaces = new Map(has('client_connections') ? all<{agent_id:string;surface:string}>(live, "SELECT agent_id,surface FROM client_connections WHERE state<>'revoked'").map(c => [c.agent_id, c.surface]) : []);
    const ask = (a: AccessAgent, reason: string) => { if (a.principal_kind !== 'human') reconnect.push({ agent_id: a.id, name: a.name, ...(surfaces.has(a.id) ? { surface: surfaces.get(a.id) } : {}), reason }); };
    const now = Date.now(), nowIso = new Date(now).toISOString();
    d.transaction(() => {
      for (const a of restored.values()) {
        const c = current.get(a.id);
        if (!c) { d.query('UPDATE agents SET active=0,api_key_hash=lower(hex(randomblob(32))),session_version=session_version+1,policy_epoch=policy_epoch+1 WHERE id=?').run(a.id); continue; }
        const tool = (TOOL_RANK[c.tool_profile] ?? 0) < (TOOL_RANK[a.tool_profile] ?? 0) ? c.tool_profile : a.tool_profile;
        // Authority profiles are not ordered by power: the current one is the owner's latest decision, so a role
        // lowered after the backup stays lowered.
        // So are the agent type (a steward demoted after the backup is not a steward again), the shared-context
        // toggle and the memory policy; the old skill API stays only if both copies allow it.
        d.query(`UPDATE agents SET api_key_hash=?,active=?,session_version=?,policy_epoch=?,tool_profile=?,authority_profile=?,type=?,legacy_skill_access=?,
          metadata=CASE WHEN ? IS NULL THEN json_remove(metadata,'$.shared_context') ELSE json_set(metadata,'$.shared_context',json('false')) END WHERE id=?`)
          .run(c.api_key_hash, Math.min(a.active, c.active), Math.max(a.session_version, c.session_version), Math.max(a.policy_epoch, c.policy_epoch), tool, c.authority_profile,
            c.type, Math.min(a.legacy_skill_access, c.legacy_skill_access), c.shared === 0 ? 0 : null, a.id);
        if (memory) d.query('UPDATE agents SET memory_mode=?,memory_mode_revision=?,memory_mode_updated_at_ms=?,memory_mode_actor_id=? WHERE id=?')
          .run(c.memory_mode!, Math.max(a.memory_mode_revision ?? 0, c.memory_mode_revision ?? 0), c.memory_mode_updated_at_ms ?? null, c.memory_mode_actor_id ?? null, a.id);
        if (c.active && !a.active) ask(c, 'disabled in the backup: enable it again in Qoopia');
      }
      for (const c of current.values()) if (c.active && !restored.has(c.id)) ask(c, 'connected after the backup was taken: connect it again');
      const workspaces = new Set(all<{id:string}>(d, 'SELECT id FROM workspaces').map(w => w.id));
      if (has('oauth_clients')) {
        const liveClients = new Map(all<Record<string, unknown> & {id:string;agent_id:string|null;workspace_id:string|null;client_secret_hash:string}>(live, 'SELECT * FROM oauth_clients').map(c => [c.id, c]));
        for (const { id } of all<{id:string}>(d, 'SELECT id FROM oauth_clients')) {
          const c = liveClients.get(id);
          if (!c) d.query("UPDATE oauth_clients SET client_secret_hash=lower(hex(randomblob(32))),redirect_uris='[]' WHERE id=?").run(id);
          else d.query('UPDATE oauth_clients SET client_secret_hash=? WHERE id=?').run(c.client_secret_hash, id);
        }
        for (const c of liveClients.values()) if ((c.agent_id === null || restored.has(c.agent_id)) && (c.workspace_id === null || workspaces.has(c.workspace_id))) copy('oauth_clients', c);
      }
      if (has('oauth_tokens')) {
        const liveTokens = new Map(all<{token_hash:string;revoked:number}>(live, 'SELECT token_hash,revoked FROM oauth_tokens').map(t => [t.token_hash, t.revoked]));
        for (const { token_hash } of all<{token_hash:string}>(d, 'SELECT token_hash FROM oauth_tokens WHERE revoked=0'))
          if (liveTokens.get(token_hash) !== 0) d.query('UPDATE oauth_tokens SET revoked=1 WHERE token_hash=?').run(token_hash);
        const clients = new Set(all<{id:string}>(d, 'SELECT id FROM oauth_clients').map(c => c.id));
        for (const t of all<Record<string, unknown> & {client_id:string;agent_id:string;workspace_id:string}>(live, "SELECT * FROM oauth_tokens WHERE revoked=0 AND datetime(expires_at) > datetime('now')"))
          if (clients.has(t.client_id) && restored.has(t.agent_id) && workspaces.has(t.workspace_id)) copy('oauth_tokens', t);
      }
      const revokeMs = (table: string) => { if (!has(table)) return;
        const later = new Map(all<{id:string;revoked_at_ms:number|null}>(live, `SELECT id,revoked_at_ms FROM "${table}"`).map(r => [r.id, r.revoked_at_ms]));
        for (const { id } of all<{id:string}>(d, `SELECT id FROM "${table}" WHERE revoked_at_ms IS NULL`))
          if (!later.has(id) || later.get(id) !== null) d.query(`UPDATE "${table}" SET revoked_at_ms=? WHERE id=?`).run(later.get(id) ?? now, id); };
      revokeMs('agent_pairings'); revokeMs('publisher_keys');
      if (has('client_connections')) {
        const later = new Map(all<{id:string;state:string;revoked_at:string|null}>(live, 'SELECT id,state,revoked_at FROM client_connections').map(r => [r.id, r]));
        for (const { id } of all<{id:string}>(d, "SELECT id FROM client_connections WHERE state<>'revoked'")) {
          const c = later.get(id);
          if (!c || c.state === 'revoked') d.query("UPDATE client_connections SET state='revoked',revoked_at=? WHERE id=?").run(c?.revoked_at ?? nowIso, id);
        }
      }
      // Sends queued at backup time have happened since; replaying them would message people twice.
      if (tableExists(d, 'qoopia_telegram_channels')) {
        d.query("UPDATE qoopia_telegram_inbox SET state='cancelled' WHERE state IN ('queued','starting','running')").run();
        d.query("UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE state IN ('queued','sending')").run();
      }
    }).immediate();
    assertDatabaseIntegrity(d);
    return reconnect;
  } finally { d.close(); live.close(); }
}
