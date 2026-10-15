import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { env } from '../src/utils/env.ts';
import { computeLogicalDatabaseHash } from '../src/db/v4-migrations.ts';
import { backupUnified, snapshotInfo, verifyBackup } from '../src/delivery/snapshot.ts';

function table(rows: Array<[string, Uint8Array | number | null]>) {
  const database = new Database(':memory:');
  // No INTEGER PRIMARY KEY: VACUUM INTO may renumber these rowids, so order must come from the values.
  database.exec('CREATE TABLE t (label TEXT COLLATE NOCASE, value)');
  for (const row of rows) database.query('INSERT INTO t VALUES (?, ?)').run(...row);
  return database;
}

test('format 2 depends on the rows, not on their physical order, and never equals format 1', () => {
  const rows: Array<[string, Uint8Array | number | null]> = [['b', 2], ['B', 2], ['a', new Uint8Array([1, 2])], ['a', null], ['c', 1.5]];
  const forward = table(rows), backward = table([...rows].reverse()), changed = table([...rows.slice(1), ['b', 3]]);
  expect(computeLogicalDatabaseHash(forward, 2)).toBe(computeLogicalDatabaseHash(backward, 2));
  expect(computeLogicalDatabaseHash(forward, 1)).toBe(computeLogicalDatabaseHash(backward, 1));
  expect(computeLogicalDatabaseHash(forward, 2)).not.toBe(computeLogicalDatabaseHash(changed, 2));
  expect(computeLogicalDatabaseHash(forward, 2)).not.toBe(computeLogicalDatabaseHash(forward, 1));
});

test('format 2 streams a large table: memory does not grow with the table as format 1 does [A1-03]', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-hash-')), 'big.db');
  const database = new Database(file);
  try {
    database.exec('CREATE TABLE big (body TEXT)');
    const insert = database.query('INSERT INTO big VALUES (?)'), filler = 'x'.repeat(4000);
    database.transaction(() => { for (let i = 0; i < 30_000; i++) insert.run(`${i % 977}-${filler}-${i}`); })();
    const grows = (format: 1 | 2) => {
      Bun.gc(true); const before = process.memoryUsage().rss;
      computeLogicalDatabaseHash(database, format);
      return process.memoryUsage().rss - before;
    };
    // ~120 MB of rows: format 1 holds them all as strings, format 2 only SQLite's sorter pages.
    // Measured: format 2 about 25 MB, format 1 about 230 MB.
    expect(grows(2)).toBeLessThan(60 * 1024 * 1024);
  } finally { database.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
}, 60_000);

test('a new backup records format 2; a format-1 backup from an earlier version still verifies', () => {
  runMigrations();
  const instance = (db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-hash-backup-')));
  try {
    const folder = path.join(root, 'qoopia-2026-10-14T04-00-00-000Z.backup');
    const manifest = backupUnified(path.join(env.DATA_DIR, 'qoopia.db'), folder, instance, env.OPS_STATE_DIR);
    expect(manifest.logical_hash_format).toBe(2);
    expect(verifyBackup(folder, instance).logical_hash).toBe(manifest.logical_hash);
    // The same snapshot as an earlier version wrote it: a format-1 hash and no format field.
    const file = path.join(folder, 'manifest.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { logical_hash_format: _format, ...legacy } = stored;
    legacy.logical_hash = snapshotInfo(path.join(folder, 'snapshot.db')).logical_hash;
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(verifyBackup(folder, instance).logical_hash).toBe(legacy.logical_hash);
    // A format-1 hash that claims format 2 is refused, so the format cannot be swapped silently.
    fs.writeFileSync(file, JSON.stringify({ ...legacy, logical_hash_format: 2 }));
    expect(() => verifyBackup(folder, instance)).toThrow('Backup inventory mismatch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
