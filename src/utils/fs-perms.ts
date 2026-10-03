/**
 * Filesystem permission helpers.
 *
 * Qoopia stores notes, transcripts, OAuth token hashes, and API key hashes
 * on disk. These directories MUST be 0700 (owner-only) and backup files 0600.
 *
 * QSEC-003 (Codex review 2026-04-25): historically only DATA_DIR was chmodded;
 * LOG_DIR / BACKUP_DIR inherited the user's umask, so on a permissive umask
 * (022) backup files could end up world-readable. These helpers fix that.
 */
import fs from "node:fs";

/**
 * Apply the private mode, then fail closed if group/other bits remain. A path
 * we cannot chmod (another uid, odd mount) is accepted only if already private.
 */
function tighten(target: string, privateMode: number): void {
  try { fs.chmodSync(target, privateMode); } catch { /* the mode check below decides */ }
  const mode = fs.statSync(target).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${target} has mode 0${mode.toString(8)}, but it holds secrets and must not be group/other accessible. Run: chmod 0${privateMode.toString(8)} ${target}`);
  }
}

/**
 * Create dir (recursive) and set mode 0700. Idempotent.
 * Re-applies chmod even if dir already existed — protects against installs
 * created under a permissive umask before the hardening landed.
 */
export function ensureSafeDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(dir, 0o700);
}

/**
 * Set file mode to 0600. Use after writing any file that contains DB content,
 * tokens, or hashes (e.g., backup .db, exported snapshots).
 */
export function ensureSafeFile(file: string): void {
  tighten(file, 0o600);
}
