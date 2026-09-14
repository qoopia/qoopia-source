import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openReadonlyDatabase, openWritableDatabase } from '../db/sqlite.ts';
import { safePath } from './files.ts';
import { snapshotInfo, verifyBackup, backupMembers } from './snapshot.ts';
export type Check = { status: 'pass' | 'fail' | 'unknown'; reason: string; action: string; [key: string]: unknown };
export function inspectScheduledBackups(root: string, instance: string, now = Date.now()) {
  try {
    safePath(root);
    if (!fs.existsSync(root)) return { status: 'unknown', reason: 'NO_SCHEDULED_BACKUP', action: 'Run owner backup or maintenance.' };
    const names = fs.readdirSync(root).filter(n => /^qoopia-\d{4}-\d{2}-\d{2}T[0-9Z-]+\.backup$/.test(n)).sort().reverse();
    if (!names.length) return { status: 'unknown', reason: 'NO_SCHEDULED_BACKUP', action: 'Run owner backup or maintenance.' };
    const latest=safePath(path.join(root,names[0]!));
    backupMembers(latest);
    const backup=verifyBackup(latest,instance);
    const age = now - Date.parse(backup.created_at);
    if (!Number.isFinite(age) || age < 0 || age > 86400000) return { status: 'fail', reason: 'BACKUP_STALE_OR_CLOCK_INVALID', action: 'Check clock and run verified backup.' };
    if (!backup.operations) return { status:'unknown',reason:'LEGACY_BACKUP_OPERATIONS_NOT_CAPTURED',action:'Create a current installation backup; historical alert recovery is unknown.' };
    return { status: 'pass', reason: 'LATEST_SCHEDULED_BACKUP_VERIFIED', age_ms: age, sha256: backup.sha256, action: 'No backup repair needed.' };
  } catch { return { status: 'fail', reason: 'BACKUP_INVALID', action: 'Preserve backup and inspect corruption or instance mismatch; create a new verified backup.' }; }
}
/** Inspect disposable copies, so SQLite cannot create journal/shm files in user data. */
export function inspectDoctorDatabase(file: string) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-doctor-'));
  try {
    const copied = path.join(temp, 'snapshot.db');
    const observations: {file:string; size:number; mtime:number; ino:number}[] = [];
    for (const suffix of ['', '-wal']) {
      const source = safePath(file + suffix);
      if (!fs.existsSync(source)) continue;
      const stat = fs.statSync(source);
      observations.push({file:source,size:stat.size,mtime:stat.mtimeMs,ino:stat.ino});
      fs.copyFileSync(source, copied + suffix); fs.chmodSync(copied + suffix, 0o600);
    }
    const prepared=openWritableDatabase(copied);
    try {
    prepared.query('SELECT count(*) FROM sqlite_master').get();
    const summary = snapshotInfo(copied), database = openReadonlyDatabase(copied);
    try {
      const owners = database.query('SELECT count(*) n FROM workspace_owners').get() as {n:number};
      const runtimes = database.query('SELECT count(*) n FROM runtime_registrations').get() as {n:number};
      // Real FTS query, no rebuild/integrity command that writes to a virtual table.
      database.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'qoopia_doctor_nonsecret_probe' LIMIT 1").all();
      for (const before of observations) {
        const after = fs.statSync(before.file);
        if (after.size !== before.size || after.mtimeMs !== before.mtime || after.ino !== before.ino) throw new Error('DATABASE_CHANGED_DURING_INSPECTION');
      }
      return { summary, owners: owners.n, runtimes: runtimes.n };
    } finally { database.close(); }
    } finally { prepared.close(); }
  } finally { fs.rmSync(temp, {recursive:true,force:true}); }
}
