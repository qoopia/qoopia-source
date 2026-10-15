import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { p1Database } from './helpers/p1-fixtures.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';

test('the operator grants and withdraws the dreamer role for the owner from the admin CLI', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dreamer-cli-'))), data = path.join(directory, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const fixture = p1Database(51), owner = bootstrapOwner(fixture, 'Dream owner', 'Dream workspace');
  const slug = (fixture.query('SELECT slug FROM workspaces WHERE id=?').get(owner.workspace_id) as { slug: string }).slug;
  fixture.query("INSERT INTO agents (id, workspace_id, name, type, api_key_hash, active, created_at) VALUES ('kiri-test', ?, 'Kiri', 'standard', 'x', 1, '2026-10-14T00:00:00Z')").run(owner.workspace_id);
  fs.writeFileSync(path.join(data, 'qoopia.db'), fixture.serialize());
  fixture.close();
  const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', 'dreamer', '--workspace', slug, ...args], { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: path.join(directory, 'home'), TMPDIR: os.tmpdir(), NODE_ENV: 'test', QOOPIA_ROOT: directory, QOOPIA_LOG_LEVEL: 'error' } });
  const flag = () => { const d = new Database(path.join(data, 'qoopia.db'), { readonly: true }); try { return (d.query("SELECT json_extract(metadata,'$.dreamer') AS v FROM agents WHERE id='kiri-test'").get() as { v: number | null }).v; } finally { d.close(); } };
  try {
    expect(cli('--agent', 'Kiri').status).toBe(1);
    expect(cli('--agent', 'Nobody', '--on').stderr).toContain("not found");
    const on = cli('--agent', 'Kiri', '--on');
    expect(on.status).toBe(0);
    expect(flag()).toBe(1);
    expect(cli('--agent', 'Dream owner', '--on').status).toBe(1); // the owner already reads everything
    expect(cli('--agent', 'Kiri', '--off').status).toBe(0);
    expect(flag()).toBeNull();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
