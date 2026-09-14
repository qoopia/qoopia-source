import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LINUX_GUI_LAUNCHER = 'Open Qoopia';

export function buildLinuxLauncher(out: string) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 launcher requires a native build host');
  const file = path.join(out, LINUX_GUI_LAUNCHER);
  const result = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-fPIE', '-pie',
    '-Wl,-z,relro,-z,now', 'src/delivery/native/linux-launcher.c', '-o', file], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Linux graphical launcher build failed');
  return file;
}
