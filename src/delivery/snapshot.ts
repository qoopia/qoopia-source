import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readRecoveryOps, validateRecoveryOps, opsJournalError, OpsJournalError, opsFile, type OpsState, serializeOps } from './ops-state.ts';
import type { Database } from 'bun:sqlite';
import { openReadonlyDatabase, openWritableDatabase, assertDatabaseIntegrity } from '../db/sqlite.ts';
import { createVerifiedBackup, sha256File } from '../services/backup.ts';
import { computeLogicalDatabaseHash } from '../db/v4-migrations.ts';
import { hash, privateDirectory, durableWrite, durableCopyFile, readJson, readJsonBytes, MAX_JSON_BYTES, safePath, preflightSpace } from './files.ts';

export function inspectSnapshot(database: Database) {
  assertDatabaseIntegrity(database, 'Snapshot');
  const tables = new Set((database.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r => r.name));
  const schema = (database.query('SELECT max(version) n FROM schema_versions').get() as {n:number}).n;
  if (![37,38,39,40,41,42,43].includes(schema)) throw new Error('Unified snapshot requires schema 37, 38, 39, 40, 41, 42 or 43; use versioned source migration for 32/35');
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
/** New-machine copy only. No identity/grant promotion or original package edits. */
export function invalidateRestoredAccess(file: string) {
  const d = openWritableDatabase(file);
  try {
    d.transaction(() => {
      d.query('UPDATE agents SET api_key_hash=lower(hex(randomblob(32))),session_version=session_version+1,policy_epoch=policy_epoch+1').run();
      d.query('UPDATE oauth_tokens SET revoked=1').run();
      d.query('UPDATE agent_pairings SET revoked_at_ms=?').run(Date.now());
      d.query('UPDATE runtime_registrations SET managed_root=NULL,reporter_id=NULL,revision=revision+1').run();
      if(d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qoopia_agent_settings'").get()) {
        d.query("UPDATE qoopia_agent_settings SET enabled=0,channel='dashboard',telegram_user_id=NULL,telegram_chat_id=NULL,telegram_username=NULL,telegram_verified=0").run();
        d.query('UPDATE qoopia_agent_conversations SET native_thread_id=NULL').run();
      }
    }).immediate();
    assertDatabaseIntegrity(d);
  } finally { d.close(); }
}
