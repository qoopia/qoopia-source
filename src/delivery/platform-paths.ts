import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { privateDirectory, safePath } from '../utils/fs.ts';
export function platformPaths(explicitRoot?: string, platform = process.platform, environment = process.env, home = os.homedir()) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Unsupported owner platform');
  const base = (key: string, fallback: string) => safePath(environment[key] || fallback);
  const defaultRoot = () => safePath(platform === 'darwin' ? path.join(home, 'Library/Application Support/Qoopia') : path.join(base('XDG_DATA_HOME', path.join(home, '.local/share')), 'qoopia'));
  const root = explicitRoot === undefined ? defaultRoot() : safePath(explicitRoot);
  // setup and the autostart unit name the default root with --root: it must keep the default logs,
  // or the service writes logs where a plain `qoopia doctor` never looks.
  const isDefault = explicitRoot === undefined || (() => { try { return defaultRoot() === root; } catch { return false; } })();
  if (!isDefault) return { root, config: path.join(root, 'config'), state: path.join(root, 'state'), logs: path.join(root, 'logs') };
  return platform === 'darwin' ? { root, config: path.join(root, 'config'), state: path.join(root, 'state'), logs: safePath(path.join(home, 'Library/Logs/Qoopia')) } : {
    root, config: path.join(base('XDG_CONFIG_HOME', path.join(home, '.config')), 'qoopia'),
    state: path.join(base('XDG_STATE_HOME', path.join(home, '.local/state')), 'qoopia'),
    logs: path.join(base('XDG_STATE_HOME', path.join(home, '.local/state')), 'qoopia/logs'),
  };
}
/** Where the owner socket may live, preferred first: the private per-user runtime directory
 * ($XDG_RUNTIME_DIR, or systemd's /run/user/UID that a server started without it still finds),
 * which no other user can pre-create or periodically clean like /tmp; then /tmp/qoopia-owner-UID. */
function ownerSocketParents(uid: number, environment: NodeJS.ProcessEnv) {
  const runtime = [environment.XDG_RUNTIME_DIR, process.platform === 'linux' ? `/run/user/${uid}` : undefined].filter((dir): dir is string => {
    if (!dir || !path.isAbsolute(dir) || Buffer.byteLength(dir) > 40) return false; // sockaddr_un holds ~104 bytes
    try { const s = fs.lstatSync(dir); return s.isDirectory() && s.uid === uid && !(s.mode & 0o077); } catch { return false; }
  });
  return [...new Set([...runtime.map(dir => path.join(safePath(dir), 'qoopia-owner')), safePath(`/tmp/qoopia-owner-${uid}`)])];
}
/** Short deterministic pathname avoids sockaddr_un limits with Unicode/long data roots. */
export function ownerSocketPath(root: string, create = false, environment = process.env) {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('Owner IPC requires an unprivileged OS user');
  const name = createHash('sha256').update(safePath(root)).digest('hex').slice(0, 32), parents = ownerSocketParents(uid, environment);
  // The server binds in the preferred place; a client finds it wherever it bound (its environment may differ).
  const parent = create ? parents[0]! : parents.find(dir => fs.existsSync(path.join(dir, name, 'owner.sock'))) ?? parents[0]!;
  const directory = path.join(parent, name);
  if (create) { privateDirectory(parent); privateDirectory(directory); }
  else for (const dir of [parent, directory]) {
    // privateDirectory would create missing paths on a read-only login attempt.
    const s = fs.lstatSync(safePath(dir));
    if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o077)) throw new Error('Unsafe owner IPC directory');
  }
  return path.join(directory, 'owner.sock');
}
