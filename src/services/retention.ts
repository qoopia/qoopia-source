import { retainManagedLogs } from "../utils/managed-logs.ts";
import { recordMaintenance, opsSummary, readOps } from "../delivery/ops-state.ts";
import { deliverOpsAlerts, readOwnerAlertChannels } from "./ops-alerts.ts";
import { backupUnified, verifyBackup, backupMembers, unifiedSnapshotSchema } from "../delivery/snapshot.ts";
import { safePath, syncDirectory } from "../utils/fs.ts";
import { standaloneRoot } from "../utils/standalone.ts";
import { createVerifiedBackup } from "./backup.ts";
import { expireRecallTraceBatch } from "../db/v4-trace-retention.ts";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/connection.ts";
import { env } from "../utils/env.ts";
import { logger } from "../utils/logger.ts";
import { nowIso } from "../utils/errors.ts";
import { nextNoteWriteTimestamp } from "./note-temporal.ts";
import { ensureSafeDir } from "../utils/fs-perms.ts";
import { AGENT_WAKE_MAX_ATTEMPTS } from "./agent-wake.ts";
import { tableExists } from "../db/introspect.ts";

/**
 * Daily maintenance job:
 *  1. Task-bound purge (notes/sessions/messages bound to closed tasks > 1h old)
 *  2. Expired idempotency keys
 *  3. Old activity (> N days) and recall_log (> 90 days)
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
    // A log retention failure is reported, but must not stop the daily backup below.
    let logFailure: string | null = null;
    try { report.application_logs = retainManagedLogs(env.LOG_DIR); }
    catch { logFailure = 'LOG_RETENTION_FAILED'; logger.error("Maintenance log retention failed", { error_code: logFailure }); }
    // Up to 5.0.16 a server started with --root naming the default root (the autostart unit, setup's next
    // step) logged to <root>/logs. Nothing writes there now, so only this keeps those files to 14 days.
    const legacyLogs = standaloneRoot() === undefined ? undefined : path.join(standaloneRoot()!, 'logs');
    if (legacyLogs && path.resolve(legacyLogs) !== path.resolve(env.LOG_DIR) && fs.existsSync(path.join(legacyLogs, 'application'))) {
      try { report.legacy_application_logs = retainManagedLogs(legacyLogs); }
      catch { report.legacy_application_logs = { status: 'failed' }; logger.error("Maintenance legacy log retention failed", { error_code: 'LEGACY_LOG_RETENTION_FAILED' }); }
    }
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
    const hasDraftRefs = tableExists(db, 'skill_draft_revisions');
    const hasCaptures = tableExists(db, 'skill_captures');
    const hasLoadouts = tableExists(db, 'session_loadouts');
    const deletedUnlessReferenced = (sql: string, id: string) => {
      try { db.transaction(() => db.prepare(sql).run(id))(); return true; }
      catch (error) { if (String((error as Error)?.message).includes('FOREIGN KEY constraint failed')) return false; throw error; }
    };
    // Skill evidence is immutable. Purge private source payloads in this shared transaction,
    // but keep a workspace-scoped, observable tombstone for its existing reference.
    const reindexNote = db.prepare(`INSERT INTO notes_fts(rowid, text) SELECT n.rowid, n.text FROM notes n
      WHERE n.id = ? AND NOT EXISTS (SELECT 1 FROM notes_fts_docsize d WHERE d.id = n.rowid)`);
    const purgeTaskBound = db.transaction(() => {
      for (const t of closed) {
        const noteRefs = hasDraftRefs
          ? `EXISTS (SELECT 1 FROM skill_draft_revisions r, json_each(r.source_refs) ref
              WHERE r.workspace_id=n.workspace_id AND json_extract(ref.value,'$.kind')='note'
                AND json_extract(ref.value,'$.id')=n.id)`
          : '0';
        const notes = db.prepare(`SELECT n.id, n.workspace_id, n.updated_at_ms, ${noteRefs} AS held FROM notes n WHERE n.task_bound_id=?`).all(t.id) as Array<{ id: string; workspace_id: string; updated_at_ms: number; held: number }>;
        for (const note of notes) {
          // F-106: deleteNote already dropped a soft-deleted note from notes_fts, and the
          // notes_ad/notes_au triggers below send an FTS 'delete' regardless. Re-index the row
          // first so that delete is balanced instead of drifting the stored row total.
          // ponytail: guarding the triggers on index presence is the schema-level fix (owner-gated migration).
          reindexNote.run(note.id);
          // A row another table still references (feedback, traces, relations, provenance,
          // lifecycle, child notes...) cannot be deleted; it becomes a tombstone instead of
          // failing the whole job. The SAVEPOINT keeps the failed DELETE from leaking.
          if (!note.held && deletedUnlessReferenced('DELETE FROM notes WHERE id=?', note.id)) { notesPurged++; continue; }
          // A note write like any other: the shared allocator keeps updated_at_ms with updated_at.
          const ts = nextNoteWriteTimestamp(note.workspace_id, note.updated_at_ms);
          db.prepare(`UPDATE notes SET text='',metadata='{"source_deleted":true}',tags='[]',project_id=NULL,
            session_id=NULL,task_bound_id=NULL,deleted_at=?,updated_at=?,updated_at_ms=? WHERE id=?`).run(ts.iso, ts.iso, ts.ms, note.id);
          notesTombstoned++;
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
          if (!session.held && deletedUnlessReferenced('DELETE FROM sessions WHERE id=?', session.id)) { sessionsPurged++; continue; }
          db.prepare(`UPDATE sessions SET title=NULL,metadata='{"source_deleted":true}',task_bound_id=NULL WHERE id=?`).run(session.id);
          sessionsTombstoned++;
        }
      }
    });
    // An unexpected purge failure must not stop token/trace expiry or the daily backup.
    let purgeFailure: string | null = null;
    try { purgeTaskBound(); }
    catch (error) {
      purgeFailure = 'TASK_BOUND_PURGE_FAILED';
      logger.error("Maintenance task-bound purge failed", { error_code: purgeFailure, error_class: (error as Error)?.name ?? 'Error' });
    }
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
    db.prepare(
      `DELETE FROM activity WHERE datetime(created_at) < datetime('now', ?)`,
    ).run(`-${env.RETENTION_ACTIVITY_DAYS} days`);
    // F-280: Bun's .changes also counts the activity_ad trigger's FTS shadow writes;
    // changes() counts only the rows this DELETE removed.
    report.activity_deleted = (db.query("SELECT changes() AS n").get() as { n: number }).n;

    // F-105: recall_log keeps (redacted) query text; the 90-day sweep migration 015 promised.
    // Raw ISO comparison keeps idx_recall_log_created_at usable; created_at uses the same format.
    report.recall_log_deleted = db
      .prepare(`DELETE FROM recall_log WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')`)
      .run().changes;

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
    const failure = purgeFailure ?? logFailure;
    const state = recordMaintenance(env.OPS_STATE_DIR, installation, failure);
    report.operations = opsSummary(env.OPS_STATE_DIR);
    if (failure) report.error = failure;
    report.ok = state.last_run?.ok === true && !failure;
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
let catchUpTimer: ReturnType<typeof setInterval> | null = null;
let maintenanceRunning: Promise<unknown> | null = null, lastAttemptAt = 0;

/** Scheduled runs never overlap: a run already in progress is joined, not repeated. */
function runScheduled() {
  if (maintenanceRunning) return maintenanceRunning;
  lastAttemptAt = Date.now();
  return maintenanceRunning = runOperationalMaintenance().finally(() => { maintenanceRunning = null; });
}

/** Long timers do not follow the wall clock on a sleeping laptop (and miss clock or timezone changes):
 * once the last successful run is a day old and this process has not tried for a day, run now.
 * Returns the started run, or null. A failing run is retried by the daily timer, not hourly. */
export function maintenanceCatchUp(now = Date.now()) {
  if (maintenanceRunning || now - lastAttemptAt < 86_400_000 || !maintenanceOverdue(now)) return null;
  return runScheduled();
}

function msUntilNextMaintenance(): number {
  const next = new Date();
  next.setHours(env.MAINTENANCE_HOUR, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

// Minimum grace period after boot before triggering maintenance (5 minutes).
// Prevents hammering the DB on rapid restarts while still respecting the window.
const BOOT_GRACE_MS = 5 * 60 * 1000;

/** No successful run in the last day. An unreadable journal keeps the configured window. */
export function maintenanceOverdue(now = Date.now()): boolean {
  let state;
  try { state = readOps(env.OPS_STATE_DIR); } catch { return false; }
  const at = state.last_run?.ok ? Date.parse(state.last_run.at) : NaN;
  return !(now - at < 86_400_000);
}

export function startMaintenance() {
  if (maintenanceEnabled) return;
  maintenanceEnabled = true;
  // Schedule the first run at the next configured maintenance window (MAINTENANCE_HOUR:00),
  // but never sooner than BOOT_GRACE_MS from now. This prevents repeated restarts from
  // postponing cleanup indefinitely (the old "1 hour from boot" approach had that problem).
  // A desktop is rarely running at the window: a run older than a day is caught up after the grace period.
  const firstRun = maintenanceOverdue() ? BOOT_GRACE_MS : Math.max(msUntilNextMaintenance(), BOOT_GRACE_MS);

  maintenanceTimer = setTimeout(() => {
    if (!maintenanceEnabled) return;
    return runScheduled().finally(scheduleDaily);
  }, firstRun);
  // Fire-and-forget: don't block event loop shutdown
  if (maintenanceTimer && typeof (maintenanceTimer as any).unref === "function") {
    (maintenanceTimer as any).unref();
  }
  catchUpTimer = setInterval(() => { if (maintenanceEnabled) void maintenanceCatchUp(); }, 3_600_000);
  catchUpTimer.unref();
  const hoursUntil = Math.round(firstRun / 1000 / 60);
  logger.info(`Maintenance scheduled: first run in ~${hoursUntil}m (window=${env.MAINTENANCE_HOUR}:00)`);
}

function scheduleDaily() {
  if (!maintenanceEnabled) return;
  const ms = msUntilNextMaintenance();
  maintenanceTimer = setTimeout(() => {
    if (!maintenanceEnabled) return;
    return runScheduled().finally(scheduleDaily);
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
  if (catchUpTimer) { clearInterval(catchUpTimer); catchUpTimer = null; }
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
