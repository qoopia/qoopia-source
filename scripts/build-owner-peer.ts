import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
export function buildOwnerPeer(out: string) {
  if (!['darwin-arm64', 'linux-x64'].includes(`${process.platform}-${process.arch}`)) throw new Error('Unsupported owner IPC build target');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = path.join(out, `owner-peer.${process.platform === 'darwin' ? 'dylib' : 'so'}`);
  const result = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-fPIC',
    ...(process.platform === 'darwin' ? ['-dynamiclib','-mmacosx-version-min=15.0'] : ['-shared']), 'src/delivery/native/owner-peer.c', '-o', file], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Native owner IPC bridge build failed');
  return file;
}
if (import.meta.main) {
  const out = process.argv[2];
  if (!out || !path.isAbsolute(out)) throw new Error('Absolute output directory required');
  console.log(buildOwnerPeer(out));
}
