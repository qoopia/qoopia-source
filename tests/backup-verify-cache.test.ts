import { expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as backupModule from '../src/services/backup.ts';
import { db } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { env } from '../src/utils/env.ts';
import { createWorkspace } from '../src/admin/workspaces.ts';
import { createAgent } from '../src/admin/agents.ts';
import { handleDashboardApi } from '../src/dashboard-api.ts';
import { backupUnified, rememberVerifiedBackup } from '../src/delivery/snapshot.ts';
import { inspectScheduledBackups } from '../src/delivery/doctor-checks.ts';

test('the overview verifies the latest backup once, not on every 5-second poll [A1-01]', () => {
  runMigrations();
  const ws = createWorkspace({ name: 'Backup cache' }), owner = createAgent({ name: 'Backup cache owner', type: 'steward', workspaceSlug: ws.slug });
  const instance = (db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-backup-cache-'))), original = env.BACKUP_DIR;
  const fullChecks = spyOn(backupModule, 'sha256File');
  try {
    env.BACKUP_DIR = root;
    const folder = path.join(root, `qoopia-${new Date().toISOString().replace(/[:.]/g, '-')}.backup`);
    backupUnified(path.join(env.DATA_DIR, 'qoopia.db'), folder, instance, env.OPS_STATE_DIR);
    fullChecks.mockClear();
    const overview = () => {
      let body = '';
      const req = { url: '/api/dashboard/overview', method: 'GET', headers: { authorization: 'Bearer ' + owner.api_key } } as import('node:http').IncomingMessage;
      const res = { writeHead() {}, end(value: string) { body = value; } } as unknown as import('node:http').ServerResponse;
      expect(handleDashboardApi(req, res)).toBe(true);
      return JSON.parse(body).health.verified_backup;
    };
    for (let poll = 0; poll < 3; poll++) expect(overview()).toMatchObject({ status: 'pass', reason: 'LATEST_SCHEDULED_BACKUP_VERIFIED' });
    expect(fullChecks).toHaveBeenCalledTimes(1);

    // Damage is a different file: verified again, and the failure is remembered too.
    const snapshot = path.join(folder, 'snapshot.db'), bytes = fs.readFileSync(snapshot);
    bytes[100] = bytes[100]! ^ 0xff; fs.writeFileSync(snapshot, bytes);
    for (let poll = 0; poll < 3; poll++) expect(overview()).toMatchObject({ status: 'fail', reason: 'BACKUP_INVALID' });
    expect(fullChecks).toHaveBeenCalledTimes(2);

    // A backup the scheduled maintenance made and verified itself is not checked a second time.
    const next = path.join(root, `qoopia-${new Date(Date.now() + 1000).toISOString().replace(/[:.]/g, '-')}.backup`);
    backupUnified(path.join(env.DATA_DIR, 'qoopia.db'), next, instance, env.OPS_STATE_DIR);
    rememberVerifiedBackup(next); fullChecks.mockClear();
    expect(inspectScheduledBackups(root, instance)).toMatchObject({ status: 'pass' });
    expect(fullChecks).not.toHaveBeenCalled();
    expect(inspectScheduledBackups(root, 'another-installation')).toMatchObject({ status: 'fail', reason: 'BACKUP_INVALID' });
  } finally { fullChecks.mockRestore(); env.BACKUP_DIR = original; fs.rmSync(root, { recursive: true, force: true }); }
});
