import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildLinuxLauncher } from '../scripts/build-linux-launcher.ts';

if (process.platform === 'linux' && process.arch === 'x64') {
  test('graphical launcher opens its own adjacent bundle with literal arguments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-launcher-'));
    try {
      const folder = path.join(root, 'folder with spaces \' " $(touch SHOULD-NOT-EXIST)');
      fs.mkdirSync(folder);
      const launcher = buildLinuxLauncher(folder);
      const application = path.join(folder, 'qoopia');
      fs.writeFileSync(application, '#!/bin/sh\nprintf "%s\\0" "$0" "$@" "$PWD"\nexit 23\n', { mode: 0o755 });
      const args = ['--root', path.join(root, 'data with spaces'), 'literal;$(touch SHOULD-NOT-EXIST)'];
      const result = spawnSync(launcher, args, { cwd: root, encoding: 'utf8', env: { PATH: '/nonexistent' } });
      expect(result.status).toBe(23);
      expect(result.stdout.split('\0')).toEqual([application, 'open', ...args, folder, '']);
      expect(fs.existsSync(path.join(root, 'SHOULD-NOT-EXIST'))).toBe(false);
      expect(fs.existsSync(path.join(folder, 'SHOULD-NOT-EXIST'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('graphical launcher resolves its executable location and refuses a missing adjacent application', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-launcher-'));
    try {
      const bundle = path.join(root, 'bundle'), other = path.join(root, 'other');
      fs.mkdirSync(bundle); fs.mkdirSync(other);
      const launcher = buildLinuxLauncher(bundle);
      fs.writeFileSync(path.join(bundle, 'qoopia'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
      fs.writeFileSync(path.join(other, 'qoopia'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const link = path.join(other, 'Open Qoopia'); fs.symlinkSync(launcher, link);
      expect(spawnSync(link, [], { cwd: other }).status).toBe(23);
      fs.renameSync(path.join(bundle, 'qoopia'), path.join(bundle, 'qoopia.saved'));
      const result = spawnSync(link, [], { cwd: other, encoding: 'utf8', env: { PATH: other } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Qoopia: cannot start the application');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
