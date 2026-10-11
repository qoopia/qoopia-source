import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type SpawnOptions } from 'node:child_process';
import { durableWrite, hasNulOrNewline, privateDirectory, safePath } from '../utils/fs.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** A Mac app opened from its disk image or a translocated copy has a path that vanishes after eject
 * or restart: hooks and adapters naming it would fail in every later session. */
export function stableBinary(binary: string) {
  binary = safePath(binary);
  if (binary.includes('/AppTranslocation/') || binary.startsWith('/Volumes/') && binary.includes('.app/Contents/'))
    throw new Error('Qoopia is running from its disk image or a temporary copy. Move Qoopia to Applications, open it from there, then try again.');
  return binary;
}
/** A path that keeps working across updates: an update prunes all but the two newest bundles, so a
 * hook or autostart unit naming bundles/<digest>/qoopia breaks after the second update. This POSIX
 * script follows current.json (its first "bundle" is the selected one; previous comes later).
 * Without an installation (a selected server workspace) the given binary is used as before. */
export function installationLauncher(root: string, binary: string) {
  root = safePath(root);
  // A selected server workspace makes any local installation inactive: its bundle is not the one in use.
  if (!fs.existsSync(path.join(root, 'current.json')) || fs.existsSync(path.join(root, 'server-workspace.json'))) return stableBinary(binary);
  if (hasNulOrNewline(root)) throw new Error('Invalid installation path');
  const file = path.join(root, 'bin', 'qoopia');
  const script = '#!/bin/sh\nset -eu\nroot=' + quote(root) + '\n' +
    'selected=$(grep -o \'"bundle":"[0-9a-f]\\{64\\}"\' "$root/current.json" | head -n 1 | cut -d\'"\' -f4)\n' +
    '[ "${#selected}" -eq 64 ] || exit 64\n' +
    'exec "$root/bundles/$selected/qoopia" "$@"\n';
  if (!fs.existsSync(file) || fs.readFileSync(safePath(file), 'utf8') !== script) {
    privateDirectory(path.dirname(file));
    durableWrite(file, script, 0o700);
  }
  return file;
}

/** A launcher that dispatches to the installed bundle stays the parent of the long-running server:
 * killing the launcher alone must stop that server too, not orphan it holding the port. SIGHUP (the
 * terminal closed) becomes SIGTERM so the server shuts down cleanly. Resolves with the child's exit
 * status, 128+signal when a signal ended it. */
export function runForwardingSignals(command: string, args: string[], options: SpawnOptions): Promise<number> {
  const child = spawn(command, args, options);
  const forward: Record<string, NodeJS.Signals> = { SIGTERM: 'SIGTERM', SIGINT: 'SIGINT', SIGHUP: 'SIGTERM' };
  const handlers = Object.entries(forward).map(([received, sent]) => {
    const handler = () => { child.kill(sent); };
    process.on(received as NodeJS.Signals, handler);
    return () => process.off(received as NodeJS.Signals, handler);
  });
  return new Promise(resolve => {
    const done = (status: number) => { for (const remove of handlers) remove(); resolve(status); };
    child.once('error', () => done(1));
    child.once('exit', (code, signal) => done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });
}
