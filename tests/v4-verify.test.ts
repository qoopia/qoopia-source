import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { parseVerifyArgs } from '../scripts/v4-verify.ts';
import { p1Database } from './helpers/p1-fixtures.ts';

test('v4-verify argument parser requires every input and integer counts', () => {
  const full = ['--db', '/d', '--expect-schema', '47', '--legacy-source', '/l', '--legacy-value-free-manifest', '/m',
    '--reconciliation-manifest', '/r', '--expect-legacy-active', '0', '--report', '/o'];
  expect(parseVerifyArgs(full)).toEqual({ dbPath: '/d', expectSchema: 47, legacySourcePath: '/l', legacyValueFreeManifestPath: '/m',
    reconciliationManifestPath: '/r', expectLegacyActive: 0, reportPath: '/o' });
  expect(() => parseVerifyArgs(full.slice(0, -2))).toThrow('are required');
  expect(() => parseVerifyArgs([...full, '--extra'])).toThrow('Unknown argument: --extra');
  expect(() => parseVerifyArgs(full.map(value => value === '47' ? '4x' : value))).toThrow('--expect-schema requires an integer');
});

test('v4-verify fails a sound database whose legacy source and reconciliation manifest are not the accepted ones', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v4-verify-')));
  try {
    const target = path.join(directory, 'target.db'), legacy = path.join(directory, 'legacy.db');
    const fixture = p1Database(47);
    fs.writeFileSync(target, fixture.serialize());
    fixture.close();
    const source = new Database(legacy, { create: true });
    source.run('CREATE TABLE notes(id TEXT PRIMARY KEY, deleted_at TEXT)');
    source.close();
    const sha = createHash('sha256').update(fs.readFileSync(legacy)).digest('hex');
    const manifest = path.join(directory, 'legacy.manifest'), reconciliation = path.join(directory, 'reconciliation.jsonl');
    fs.writeFileSync(manifest, `sha256=${sha}\ncontains_row_values=false\nsqlite_integrity_check=ok\n`);
    fs.writeFileSync(reconciliation, '');
    const report = path.join(directory, 'out', 'report.json');
    const result = spawnSync(process.execPath, ['scripts/v4-verify.ts', '--db', target, '--expect-schema', '47', '--legacy-source', legacy,
      '--legacy-value-free-manifest', manifest, '--reconciliation-manifest', reconciliation, '--expect-legacy-active', '0', '--report', report],
      { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory, TMPDIR: os.tmpdir() } });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, schema: 47, legacy_coverage: '0/0', missing: 0, report });
    const written = JSON.parse(fs.readFileSync(report, 'utf8'));
    expect(written.errors).toEqual(['Legacy source hash does not match accepted split-brain decision',
      'Reconciliation manifest hash does not match accepted decision']);
    expect(written).toMatchObject({ ok: false, contains_note_bodies: false, production_actions: false,
      integrity: { quick_check: ['ok'], integrity_check: ['ok'], foreign_key_violations: 0, cross_workspace_violations: 0 } });
    expect(fs.statSync(report).mode & 0o777).toBe(0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
