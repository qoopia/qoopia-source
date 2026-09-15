import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { privateDirectory, safePath } from '../utils/fs.ts';
export function platformPaths(explicitRoot?: string, platform = process.platform, environment = process.env, home = os.homedir()) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Unsupported owner platform');
  const base = (key: string, fallback: string) => safePath(environment[key] || fallback);
  const root = safePath(explicitRoot ?? (platform === 'darwin' ? path.join(home, 'Library/Application Support/Qoopia') : path.join(base('XDG_DATA_HOME', path.join(home, '.local/share')), 'qoopia')));
  if (explicitRoot) return { root, config: path.join(root, 'config'), state: path.join(root, 'state'), logs: path.join(root, 'logs') };
  return platform === 'darwin' ? { root, config: path.join(root, 'config'), state: path.join(root, 'state'), logs: safePath(path.join(home, 'Library/Logs/Qoopia')) } : {
    root, config: path.join(base('XDG_CONFIG_HOME', path.join(home, '.config')), 'qoopia'),
    state: path.join(base('XDG_STATE_HOME', path.join(home, '.local/state')), 'qoopia'),
    logs: path.join(base('XDG_STATE_HOME', path.join(home, '.local/state')), 'qoopia/logs'),
  };
}
/** Short deterministic pathname avoids sockaddr_un limits with Unicode/long data roots. */
export function ownerSocketPath(root: string, create = false) {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('Owner IPC requires an unprivileged OS user');
  const parent = safePath(`/tmp/qoopia-owner-${uid}`);
  const directory = path.join(parent, createHash('sha256').update(safePath(root)).digest('hex').slice(0, 32));
  if (create) { privateDirectory(parent); privateDirectory(directory); }
  else for (const dir of [parent, directory]) {
    // privateDirectory would create missing paths on a read-only login attempt.
    const s = fs.lstatSync(safePath(dir));
    if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o077)) throw new Error('Unsafe owner IPC directory');
  }
  return path.join(directory, 'owner.sock');
}
