import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openReadonlyDatabase, openWritableDatabase } from '../db/sqlite.ts';
import { spawnSync } from 'node:child_process';
import { safePath, readJson } from '../utils/fs.ts';
import { snapshotInfo, verifyBackupOnce } from './snapshot.ts';
export type Check = { status: 'pass' | 'warn' | 'fail' | 'unknown'; reason: string; action: string; [key: string]: unknown };
/** Allowed clock skew before a backup counts as dated in the future. */
const BACKUP_CLOCK_SKEW_MS = 5 * 60_000;
export const BACKUP_DATED_IN_FUTURE = { status: 'fail', reason: 'BACKUP_DATED_IN_FUTURE',
  action: 'A backup is dated after the current time: the clock was wrong when it was made. Check the system date and time. The backup is kept and can still be restored; backup freshness ignores it.' } as const;
export function inspectScheduledBackups(root: string, instance: string, now = Date.now()) {
  try {
    safePath(root);
    if (!fs.existsSync(root)) return { status: 'unknown', reason: 'NO_SCHEDULED_BACKUP', action: 'Run owner backup or maintenance.' };
    const all = fs.readdirSync(root).filter(n => /^qoopia-\d{4}-\d{2}-\d{2}T[0-9Z-]+\.backup$/.test(n)).sort().reverse();
    // A backup made while the clock ran ahead would stay "latest" forever; it is reported on its own.
    const created = (name: string) => { try { return Date.parse(readJson<{created_at?: string}>(path.join(root, name, 'manifest.json')).created_at ?? ''); } catch { return NaN; } };
    const names = all.filter(name => !(created(name) > now + BACKUP_CLOCK_SKEW_MS)), future = all.length - names.length;
    if (!names.length) return future ? { ...BACKUP_DATED_IN_FUTURE, future_dated: future } : { status: 'unknown', reason: 'NO_SCHEDULED_BACKUP', action: 'Run owner backup or maintenance.' };
    const backup=verifyBackupOnce(safePath(path.join(root,names[0]!)),instance);
    const age = now - Date.parse(backup.created_at);
    if (!Number.isFinite(age) || age < 0 || age > 86400000) return { status: 'fail', reason: 'BACKUP_STALE_OR_CLOCK_INVALID', action: 'Check clock and run verified backup.' };
    if (!backup.operations) return { status:'unknown',reason:'LEGACY_BACKUP_OPERATIONS_NOT_CAPTURED',action:'Create a current installation backup; historical alert recovery is unknown.' };
    return { status: 'pass', reason: 'LATEST_SCHEDULED_BACKUP_VERIFIED', age_ms: age, sha256: backup.sha256, action: 'No backup repair needed.', ...(future ? { future_dated: future } : {}) };
  } catch { return { status: 'fail', reason: 'BACKUP_INVALID', action: 'Preserve backup and inspect corruption or instance mismatch; create a new verified backup.' }; }
}
/** Runbooks and hook notices say `qoopia …`; on a Mac the program sits inside the app bundle and is on no PATH [A7-13].
 * Read-only: names the link to make, with $HOME instead of the owner's home path. */
export function cliCommandCheck(root: string, binary = process.execPath, environment = process.env, home = os.homedir()) {
  const found = (environment.PATH ?? '').split(':').some(dir => { try { fs.accessSync(path.join(dir, 'qoopia'), fs.constants.X_OK); return true; } catch { return false; } });
  if (found) return { status: 'pass' as const, reason: 'QOOPIA_ON_PATH', action: 'No repair needed.' };
  // The installation launcher follows updates; without an installation the app's own program does.
  const target = fs.existsSync(path.join(root, 'bin', 'qoopia')) ? path.join(root, 'bin', 'qoopia') : binary;
  const shown = target.startsWith(home + '/') ? '$HOME' + target.slice(home.length) : target;
  return { status: 'warn' as const, reason: 'QOOPIA_NOT_ON_PATH', action: `The qoopia command used in Qoopia's instructions is not on your PATH. Run: mkdir -p "$HOME/.local/bin" && ln -sf "${shown}" "$HOME/.local/bin/qoopia" (and add $HOME/.local/bin to PATH if your shell lacks it).` };
}
/** Linux: the bundled sandbox must be able to create a user namespace. Ubuntu 24.04 lets only /usr/bin/bwrap
 * do that (AppArmor), and the memory model fails without it [A7-07]. Runs `bwrap … true` once; read-only. */
export function linuxSandboxCheck(wrapper: string, platform = process.platform, run = (file: string, args: string[]) => spawnSync(file, args, { encoding: 'utf8', timeout: 10_000 })) {
  if (platform !== 'linux' || !fs.existsSync(wrapper)) return { status: 'pass' as const, reason: 'SANDBOX_NOT_USED', action: 'No repair needed.' };
  const probe = run(wrapper, ['--ro-bind', '/', '/', '--dev', '/dev', '/bin/true']);
  if (probe.status === 0) return { status: 'pass' as const, reason: 'SANDBOX_STARTS', action: 'No repair needed.' };
  let restricted = false; try { restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; } catch { /* not an AppArmor kernel */ }
  return { status: 'fail' as const, reason: restricted ? 'SANDBOX_USERNS_RESTRICTED' : 'SANDBOX_FAILED',
    action: restricted ? 'This system (Ubuntu 24.04 and later) allows user namespaces only to the system bubblewrap. Install it: sudo apt install bubblewrap. Qoopia then uses /usr/bin/bwrap for the memory model.'
      : 'The bundled sandbox (bubblewrap) could not start, so the memory model cannot run. Check that unprivileged user namespaces are enabled (sysctl kernel.unprivileged_userns_clone=1) or install your distribution\'s bubblewrap package.' };
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
