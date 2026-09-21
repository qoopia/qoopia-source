import { retainManagedLogs } from "../utils/managed-logs.ts";
import { recordMaintenance, opsSummary } from "../delivery/ops-state.ts";
import { deliverOpsAlerts, readOwnerAlertChannels } from "./ops-alerts.ts";
import { backupUnified, verifyBackup, backupMembers, unifiedSnapshotSchema } from "../delivery/snapshot.ts";
import { safePath, syncDirectory } from "../utils/fs.ts";
import { createVerifiedBackup } from "./backup.ts";
import { expireRecallTraceBatch } from "../db/v4-trace-retention.ts";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/connection.ts";
import { env } from "../utils/env.ts";
import { logger } from "../utils/logger.ts";
import { nowIso } from "../utils/errors.ts";
import { ensureSafeDir } from "../utils/fs-perms.ts";
import { AGENT_WAKE_MAX_ATTEMPTS } from "./agent-wake.ts";

/**
 * Daily maintenance job:
 *  1. Task-bound purge (notes/sessions/messages bound to closed tasks > 1h old)
 *  2. Expired idempotency keys
 *  3. Old activity (> N days)
 *  4. Terminal AgentComm wake events
 *  5. Expired oauth codes/access tokens
 *  6. Daily backup via VACUUM INTO
 *  7. Rotate backups (keep N latest)
 */

/**
 * Delete only terminal wake rows after the explicit retention window.
 * Retryable queued/failed rows are deliberately excluded.
 */
export function pruneTerminalAgentWakeEvents(): number {
  const deleted = db.prepare(
    `DELETE FROM agent_wake_events
      WHERE datetime(created_at) < datetime('now', ?)
        AND (
          status IN ('delivered', 'ignored')
          OR (status = 'failed' AND attempt_count >= ?)
        )`,
  ).run(`-${env.RETENTION_AGENT_WAKE_DAYS} days`, AGENT_WAKE_MAX_ATTEMPTS);
  return deleted.changes;
}

export function runMaintenance(): { ok: boolean; report: Record<string, unknown> } {
  const report: Record<string, unknown> = { started_at: nowIso() };
  let stage = 'DATABASE', installation = 'local';
  try {
    installation = (db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string} | null)?.instance_id ?? 'local';
    stage = 'LOG_RETENTION';
    report.application_logs = retainManagedLogs(env.LOG_DIR);
    stage = 'DATABASE';
    // 1. Task-bound purge
    const closed = db
      .prepare(
        `SELECT id FROM notes
         WHERE type = 'task'
           AND deleted_at IS NULL
           AND json_extract(metadata, '$.status') IN ('done', 'cancelled')
           AND datetime(updated_at) <= datetime('now', '-1 hour')`,
      )
      .all() as Array<{ id: string }>;

    let notesPurged = 0;
    let notesTombstoned = 0;
    let sessionsPurged = 0;
    let sessionsTombstoned = 0;
    let messagesPurged = 0;
    const hasTable = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const hasDraftRefs = hasTable('skill_draft_revisions');
    const hasCaptures = hasTable('skill_captures');
    const hasLoadouts = hasTable('session_loadouts');
    const deletedAt = nowIso();
    // Skill evidence is immutable. Purge private source payloads in this shared transaction,
    // but keep a workspace-scoped, observable tombstone for its existing reference.
    const purgeTaskBound = db.transaction(() => {
      for (const t of closed) {
        const noteRefs = hasDraftRefs
          ? `EXISTS (SELECT 1 FROM skill_draft_revisions r, json_each(r.source_refs) ref
              WHERE r.workspace_id=n.workspace_id AND json_extract(ref.value,'$.kind')='note'
                AND json_extract(ref.value,'$.id')=n.id)`
          : '0';
        const notes = db.prepare(`SELECT n.id, ${noteRefs} AS held FROM notes n WHERE n.task_bound_id=?`).all(t.id) as Array<{ id: string; held: number }>;
        for (const note of notes) {
          if (note.held) {
            db.prepare(`UPDATE notes SET text='',metadata='{"source_deleted":true}',tags='[]',project_id=NULL,
              session_id=NULL,task_bound_id=NULL,deleted_at=?,updated_at=? WHERE id=?`).run(deletedAt, deletedAt, note.id);
            notesTombstoned++;
          } else {
            db.prepare('DELETE FROM notes WHERE id=?').run(note.id);
            notesPurged++;
          }
        }

        const sessionRefs = [
          hasCaptures ? `EXISTS (SELECT 1 FROM skill_captures c WHERE c.workspace_id=s.workspace_id
            AND c.source_kind='session' AND json_extract(c.source_refs,'$.source_id')=s.id)` : '0',
          hasLoadouts ? `EXISTS (SELECT 1 FROM session_loadouts l WHERE l.workspace_id=s.workspace_id AND l.qoopia_session_id=s.id)` : '0',
        ].join(' OR ');
        const sessions = db.prepare(`SELECT s.id, (${sessionRefs}) AS held FROM sessions s WHERE s.task_bound_id=?`).all(t.id) as Array<{ id: string; held: number }>;
        for (const session of sessions) {
          messagesPurged += (db.query('SELECT count(*) AS n FROM session_messages WHERE session_id=?').get(session.id) as { n: number }).n;
          db.prepare('DELETE FROM session_messages WHERE session_id=?').run(session.id);
          db.prepare('DELETE FROM summaries WHERE session_id=?').run(session.id);
          if (session.held) {
            db.prepare(`UPDATE sessions SET title=NULL,metadata='{"source_deleted":true}',task_bound_id=NULL WHERE id=?`).run(session.id);
            sessionsTombstoned++;
          } else {
            db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
            sessionsPurged++;
          }
        }
      }
    });
    purgeTaskBound();
    report.task_bound_closed = closed.length;
    report.notes_purged = notesPurged;
    report.notes_tombstoned = notesTombstoned;
    report.sessions_purged = sessionsPurged;
    report.sessions_tombstoned = sessionsTombstoned;
    report.messages_purged = messagesPurged;

    // P3: bounded expiry is wired to the existing daily scheduler; feedback survives.
    report.recall_trace_expiry = expireRecallTraceBatch(db, { cutoff: nowIso() });

    // 2. Idempotency keys
    // H3 fix: normalize both sides to datetime() to avoid ISO-8601 vs SQLite format mismatch
    const idemp = db
      .prepare(`DELETE FROM idempotency_keys WHERE datetime(expires_at) < datetime('now')`)
      .run();
    report.idempotency_keys_deleted = idemp.changes;

    // 3. Old activity — use datetime() on both sides for consistent comparison
    const activityDeleted = db
      .prepare(
        `DELETE FROM activity WHERE datetime(created_at) < datetime('now', ?)`,
      )
      .run(`-${env.RETENTION_ACTIVITY_DAYS} days`);
    report.activity_deleted = activityDeleted.changes;

    // 4. Terminal AgentComm wake events. Retryable work is never pruned.
    report.agent_wake_events_deleted = pruneTerminalAgentWakeEvents();

    // 5. Expired oauth tokens (codes, access, AND refresh) + revoked tokens older than 7 days
    // H3 fix: normalize expires_at comparison via datetime()
    const oauthExpired = db
      .prepare(`DELETE FROM oauth_tokens WHERE datetime(expires_at) < datetime('now')`)
      .run();
    const oauthRevoked = db
      .prepare(
        `DELETE FROM oauth_tokens WHERE revoked = 1 AND datetime(created_at) < datetime('now', '-7 days')`,
      )
      .run();
    report.oauth_expired_deleted = oauthExpired.changes;
    report.oauth_revoked_deleted = oauthRevoked.changes;

    // P3: verified online snapshot; never unlink the last good backup before replacement.
    stage = 'BACKUP';
    const schema = (db.query('SELECT max(version) n FROM schema_versions').get() as {n:number}).n;
    const backupName = `qoopia-${new Date().toISOString().replace(/[:.]/g, '-')}${unifiedSnapshotSchema(schema) ? '.backup' : '.db'}`;
    const backupPath = path.join(env.BACKUP_DIR, backupName);
    ensureSafeDir(env.BACKUP_DIR);
    // Scheduled unified backups use the SAME recovery manifest as the local restore command.
    const backup = unifiedSnapshotSchema(schema) ? backupUnified(path.join(env.DATA_DIR,'qoopia.db'),backupPath,installation,env.OPS_STATE_DIR)
      : createVerifiedBackup({ source: path.join(env.DATA_DIR, 'qoopia.db'), output: backupPath });
    report.backup = { sha256: backup.sha256, schema, verified: true, unified_restore: unifiedSnapshotSchema(schema) };
    const backups = fs.readdirSync(env.BACKUP_DIR).filter(f => /^qoopia-\d{4}-\d{2}-\d{2}T[0-9Z-]+\.(db|backup)$/.test(f)).sort().reverse();
    const days = new Set<string>(), weeks = new Set<string>(), keep = new Set<string>();
    for (const name of backups) {
      const day = name.slice(7,17), week = String(Math.floor(Date.parse(day) / (7*86400000)));
      if (days.size < env.BACKUP_KEEP && !days.has(day)) { days.add(day); keep.add(name); }
      if (weeks.size < 4 && !weeks.has(week)) { weeks.add(week); keep.add(name); }
    }
    let deleted = 0;
    for (const name of backups) if (!keep.has(name)) {
      const file = path.join(env.BACKUP_DIR, name), stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.()) { fs.unlinkSync(file); deleted++; }
      else if(stat.isDirectory() && stat.uid===process.getuid?.() && name.endsWith('.backup')) {
        // Never recursively remove unknown additions or a corrupt backup as ordinary rotation.
        let members: string[];
        try { members=backupMembers(file); verifyBackup(file); } catch { continue; }
        for(const member of members)fs.unlinkSync(safePath(path.join(file,member)));
        fs.rmdirSync(file);deleted++;
      }
    }
    syncDirectory(env.BACKUP_DIR);
    report.backups_kept = keep.size; report.backups_deleted = deleted;

    stage = 'STATUS';
    const state = recordMaintenance(env.OPS_STATE_DIR, installation, null);
    report.operations = opsSummary(env.OPS_STATE_DIR);
    report.ok = state.last_run?.ok === true;
    report.finished_at = nowIso();
    logger.info("Maintenance complete", report);
    return { ok: report.ok === true, report };
  } catch {
    const cause = `${stage}_FAILED`;
    logger.error("Maintenance failed", { error_code: cause });
    report.ok = false;
    report.error = cause;
    report.finished_at = nowIso();
    try { recordMaintenance(env.OPS_STATE_DIR, installation, cause); }
    catch { report.status_error = 'STATUS_WRITE_FAILED'; }
    report.operations = opsSummary(env.OPS_STATE_DIR);
    return { ok: false, report };
  }
}

let maintenanceEnabled = false;
let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilNextMaintenance(): number {
  const next = new Date();
  next.setHours(env.MAINTENANCE_HOUR, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

// Minimum grace period after boot before triggering maintenance (5 minutes).
// Prevents hammering the DB on rapid restarts while still respecting the window.
const BOOT_GRACE_MS = 5 * 60 * 1000;

export function startMaintenance() {
  if (maintenanceEnabled) return;
  maintenanceEnabled = true;
  // Schedule the first run at the next configured maintenance window (MAINTENANCE_HOUR:00),
  // but never sooner than BOOT_GRACE_MS from now. This prevents repeated restarts from
  // postponing cleanup indefinitely (the old "1 hour from boot" approach had that problem).
  const msToWindow = msUntilNextMaintenance();
  const firstRun = Math.max(msToWindow, BOOT_GRACE_MS);

  maintenanceTimer = setTimeout(() => {
    if (!maintenanceEnabled) return;
    return runOperationalMaintenance().finally(scheduleDaily);
  }, firstRun);
  // Fire-and-forget: don't block event loop shutdown
  if (maintenanceTimer && typeof (maintenanceTimer as any).unref === "function") {
    (maintenanceTimer as any).unref();
  }
  const hoursUntil = Math.round(firstRun / 1000 / 60);
  logger.info(`Maintenance scheduled: first run in ~${hoursUntil}m (window=${env.MAINTENANCE_HOUR}:00)`);
}

function scheduleDaily() {
  if (!maintenanceEnabled) return;
  const ms = msUntilNextMaintenance();
  maintenanceTimer = setTimeout(() => {
    if (!maintenanceEnabled) return;
    return runOperationalMaintenance().finally(scheduleDaily);
  }, ms);
  if (maintenanceTimer && typeof (maintenanceTimer as any).unref === "function") {
    (maintenanceTimer as any).unref();
  }
}

export function stopMaintenance() {
  maintenanceEnabled = false;
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = null;
  }
}

/** The CLI and daily timer share this callback; no receiver is enabled implicitly. */
export async function runOperationalMaintenance(channels?: Parameters<typeof deliverOpsAlerts>[1]) {
  const result = runMaintenance();
  try { await deliverOpsAlerts(env.OPS_STATE_DIR, channels ?? readOwnerAlertChannels(process.env.QOOPIA_OPS_CHANNELS_FILE)); }
  catch {
    result.ok = false; result.report.ok = false; result.report.delivery_error = 'ALERT_STATUS_UNAVAILABLE';
    try {
      const instance=(db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
      recordMaintenance(env.OPS_STATE_DIR,instance,'ALERT_DELIVERY_FAILED');
    } catch { result.report.status_error='STATUS_WRITE_FAILED'; }
  }
  result.report.operations = opsSummary(env.OPS_STATE_DIR);
  return result;
}
