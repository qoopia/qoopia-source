import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('installer refuses an unmigrated database before writing keys, plists or loading services', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-refusal-'))), home = path.join(directory, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  try {
    // PATH holds only bun, so even a bypassed guard could not reach launchctl.
    const result = spawnSync(process.execPath, ['src/cli.ts', 'install', '--yes'], { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8',
      env: { PATH: path.dirname(process.execPath), HOME: home, TMPDIR: os.tmpdir(), NODE_ENV: 'test', QOOPIA_ROOT: path.join(directory, 'root'),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/install refused: \d+ pending migration\(s\)/);
    expect(fs.readdirSync(home)).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 20_000);

test('uninstall reports a LaunchAgent that launchctl did not unload and keeps its plist for a retry [F-056]', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'))), home = path.join(directory, 'home'), bin = path.join(directory, 'bin');
  const agents = path.join(home, 'Library/LaunchAgents'), plist = path.join(agents, 'com.qoopia.mcp.plist');
  fs.mkdirSync(agents, { recursive: true, mode: 0o700 }); fs.mkdirSync(bin, { mode: 0o700 });
  // A fake launchctl first on PATH; /bin and /usr/bin are absent, so the real one cannot run.
  // Like the real legacy unload it exits 0 even when the job stays loaded.
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh
case "$1" in
  unload) [ -e "${directory}/stuck" ] || /bin/rm -f "${directory}/loaded"; exit 0;;
  list) [ -e "${directory}/loaded" ] && exit 0; exit 113;;
esac
exit 1
`, { mode: 0o700 });
  const env = { PATH: bin + path.delimiter + path.dirname(process.execPath), HOME: home, TMPDIR: os.tmpdir(), NODE_ENV: 'test',
    QOOPIA_ROOT: path.join(directory, 'root'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  const run = (...args: string[]) => spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8', env });
  try {
    expect(run('scripts/migrate.ts').status).toBe(0);
    fs.writeFileSync(plist, '<plist/>'); fs.writeFileSync(path.join(directory, 'loaded'), ''); fs.writeFileSync(path.join(directory, 'stuck'), '');
    const stuck = run('src/cli.ts', 'uninstall');
    expect(stuck.status).toBe(1);
    expect(stuck.stdout).not.toContain('Service stopped');
    expect(stuck.stderr).toContain('still loaded');
    expect(fs.existsSync(plist)).toBe(true);
    fs.rmSync(path.join(directory, 'stuck'));
    const done = run('src/cli.ts', 'uninstall');
    expect(done.status).toBe(0);
    expect(done.stdout).toContain('Service stopped and plist removed.');
    expect(fs.existsSync(plist)).toBe(false);
    const none = run('src/cli.ts', 'uninstall');
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('No LaunchAgent installed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
