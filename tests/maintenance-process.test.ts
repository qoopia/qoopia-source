import { expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import * as backupModule from '../src/services/backup.ts';
import { db } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { env } from '../src/utils/env.ts';
import { runMaintenance, runMaintenanceProcess } from '../src/services/retention.ts';
import { inspectScheduledBackups } from '../src/delivery/doctor-checks.ts';
import { readOps } from '../src/delivery/ops-state.ts';

test('scheduled maintenance runs as its own process: the server keeps answering while it works [A1-02]', async () => {
  runMigrations();
  const instance = (db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  // Enough data that integrity check, VACUUM INTO and the hashes take a noticeable time.
  db.exec('CREATE TABLE maintenance_ballast (body TEXT)');
  const insert = db.query('INSERT INTO maintenance_ballast VALUES (?)'), filler = 'b'.repeat(4000);
  db.transaction(() => { for (let i = 0; i < 12_000; i++) insert.run(`${i}-${filler}`); })();
  try {
    const started = performance.now(); runMaintenance(); const inProcess = performance.now() - started;
    let last = performance.now(), worst = 0;
    const beat = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    const result = await runMaintenanceProcess();
    clearInterval(beat);
    expect(result.ok).toBe(true);
    expect(readOps(env.OPS_STATE_DIR).last_run?.ok).toBe(true);
    // In this process the same work blocks every request for its whole duration.
    expect(inProcess).toBeGreaterThan(150);
    expect(worst).toBeLessThan(Math.max(60, inProcess / 3));
    // The backup it made and verified is not copied and hashed again by the next overview poll.
    const name = (result.report.backup as {name:string}).name, fullChecks = spyOn(backupModule, 'sha256File');
    try {
      expect(fs.existsSync(path.join(env.BACKUP_DIR, name))).toBe(true);
      expect(inspectScheduledBackups(env.BACKUP_DIR, instance)).toMatchObject({ status: 'pass' });
      expect(fullChecks).not.toHaveBeenCalled();
    } finally { fullChecks.mockRestore(); }
  } finally { db.exec('DROP TABLE maintenance_ballast'); }
}, 60_000);
