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
import { logger } from "./logger.ts";

/**
 * Create dir (recursive) and set mode 0700. Idempotent.
 * Re-applies chmod even if dir already existed — protects against installs
 * created under a permissive umask before the hardening landed.
 */
export function ensureSafeDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    logger.warn(`ensureSafeDir: chmod 0700 failed for ${dir}`, {
      error: String(err),
    });
  }
}

/**
 * Set file mode to 0600. Use after writing any file that contains DB content,
 * tokens, or hashes (e.g., backup .db, exported snapshots).
 */
export function ensureSafeFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    logger.warn(`ensureSafeFile: chmod 0600 failed for ${file}`, {
      error: String(err),
    });
  }
}

/**
 * Audit a directory's mode bits. Returns true if it is 0700 (or stricter for
 * the group/other bits). Logs a warning for anything looser. Used at startup
 * to surface unsafe pre-existing installs that predate this hardening.
 *
 * Note: we only warn — we do NOT auto-chmod here, because the dir might have
 * been intentionally widened by the operator. The dedicated ensureSafeDir
 * call paths (connection.ts, install.ts) handle the create-time tightening.
 */
export function auditDirMode(dir: string): boolean {
  try {
    const st = fs.statSync(dir);
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn(
        `permission audit: ${dir} mode is 0${mode.toString(8)}, expected 0700 — ` +
          `group/other bits are set; secrets and backups may be readable by ` +
          `other local users. Run: chmod 0700 ${dir}`,
      );
      return false;
    }
    return true;
  } catch {
    // Dir doesn't exist yet (cold start before ensureSafeDir) — skip silently.
    return true;
  }
}

export function auditFileMode(file: string): boolean {
  try {
    const st = fs.statSync(file);
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn(
        `permission audit: ${file} mode is 0${mode.toString(8)}, expected 0600 — ` +
          `chmod 0600 ${file} to restrict to owner only.`,
      );
      return false;
    }
    return true;
  } catch {
    return true;
  }
}
