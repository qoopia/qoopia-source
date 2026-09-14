#!/usr/bin/env bun
/**
 * archive-stale.ts — weekly lifecycle cron.
 *
 * Sweeps three classes of stale rows and flips metadata.status='archived':
 *   1. Tasks done > 30 days ago (where metadata.status='done').
 *   2. Memory notes (type='memory') with updated_at > 90 days ago.
 *   3. Context notes (type='context') with updated_at > 30 days ago.
 *
 * Archived rows stay queryable for audit (include_archived=true) but
 * disappear from default list/recall results so dashboards stop drowning
 * in stale state.
 *
 * Reversibility: before overwriting metadata.status with 'archived', the
 * sweep preserves the prior value into metadata.previous_status (only
 * when prior status was non-null). A future un-archive step can copy
 * previous_status → status and drop previous_status to restore the
 * original business state (e.g. 'done', 'cancelled', 'in_progress').
 *
 * Idempotent: re-running is safe — already-archived rows are skipped via
 * the `metadata.status != 'archived'` predicate. The skip also protects
 * previous_status from being clobbered by a second pass.
 *
 * Triggered by launchd template `com.qoopia.archive-stale.plist` weekly
 * on Sunday 03:00 local time. Also runnable ad-hoc:
 *   bun run scripts/archive-stale.ts            # apply
 *   bun run scripts/archive-stale.ts --dry-run  # report what would change
 */
import { db } from "../src/db/connection.ts";
import { logger } from "../src/utils/logger.ts";

export interface SweepRule {
  label: string;
  // SQL predicate that finds CANDIDATES for archiving. Should NOT include
  // the deleted_at / already-archived guards — those are added by the
  // wrapper below.
  candidateSql: string;
  // P1 (codex review): bun:sqlite's .all() expects SQLQueryBindings, not
  // unknown. All current rules pass ISO date strings; widen only as far
  // as needed for future numeric/null cutoffs without breaking the type.
  candidateParams: (string | number | null)[];
}

const NOW = new Date();
function isoDaysAgo(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const rules: SweepRule[] = [
  {
    label: "tasks done > 30d",
    candidateSql: `
      type = 'task'
      AND json_extract(metadata, '$.status') = 'done'
      AND updated_at < ?
    `,
    candidateParams: [isoDaysAgo(30)],
  },
  {
    label: "memory notes updated > 90d",
    candidateSql: `
      type = 'memory'
      AND updated_at < ?
    `,
    candidateParams: [isoDaysAgo(90)],
  },
  {
    label: "context notes updated > 30d",
    candidateSql: `
      type = 'context'
      AND updated_at < ?
    `,
    candidateParams: [isoDaysAgo(30)],
  },
];

export interface SweepReport {
  label: string;
  matched: number;
  archived: number;
  ids: string[];
}

export function sweep(rule: SweepRule, dryRun: boolean): SweepReport {
  // Common guards: not already archived, not soft-deleted.
  const where = `
    deleted_at IS NULL
    AND (json_extract(metadata, '$.status') IS NULL
         OR json_extract(metadata, '$.status') != 'archived')
    AND (${rule.candidateSql})
  `;

  // Select id AND the current $.status so we can preserve it as
  // $.previous_status before we overwrite it with 'archived'. This is
  // what enables reversible un-archive: a future restore step copies
  // previous_status → status and clears previous_status. We branch in
  // JS because json_set cannot conditionally skip a path — passing a
  // bound NULL would set $.previous_status to JSON null, polluting
  // notes that originally had no status.
  const candidates = db
    .prepare(
      `SELECT id, json_extract(metadata, '$.status') AS status FROM notes WHERE ${where}`,
    )
    .all(...rule.candidateParams) as Array<{
    id: string;
    status: string | null;
  }>;

  if (dryRun || candidates.length === 0) {
    return {
      label: rule.label,
      matched: candidates.length,
      archived: 0,
      ids: candidates.map((c) => c.id),
    };
  }

  const archivedIds: string[] = [];
  // Variant A — note had a non-null $.status: preserve it as
  // $.previous_status alongside the flip to 'archived'.
  const updateStmtWithPrev = db.prepare(
    `UPDATE notes
       SET metadata = json_set(
             COALESCE(metadata, '{}'),
             '$.status', 'archived',
             '$.previous_status', ?,
             '$.archived_at', ?,
             '$.archived_by', 'archive-stale.ts'
           ),
           updated_at = ?
     WHERE id = ?`,
  );
  // Variant B — note had no $.status at all: do NOT introduce a
  // $.previous_status key (would pollute it with JSON null).
  const updateStmtNoPrev = db.prepare(
    `UPDATE notes
       SET metadata = json_set(
             COALESCE(metadata, '{}'),
             '$.status', 'archived',
             '$.archived_at', ?,
             '$.archived_by', 'archive-stale.ts'
           ),
           updated_at = ?
     WHERE id = ?`,
  );

  const now = NOW.toISOString().replace(/\.\d{3}Z$/, "Z");

  const tx = db.transaction((cs: Array<{ id: string; status: string | null }>) => {
    for (const c of cs) {
      if (c.status != null) {
        updateStmtWithPrev.run(c.status, now, now, c.id);
      } else {
        updateStmtNoPrev.run(now, now, c.id);
      }
      archivedIds.push(c.id);
    }
  });
  tx(candidates);

  return {
    label: rule.label,
    matched: candidates.length,
    archived: archivedIds.length,
    ids: archivedIds,
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = NOW.toISOString();

  logger.info(`archive-stale starting (dry_run=${dryRun}) at ${startedAt}`);

  const reports: SweepReport[] = [];
  for (const rule of rules) {
    const r = sweep(rule, dryRun);
    reports.push(r);
    logger.info(
      `  ${r.label}: matched=${r.matched} archived=${r.archived}` +
        (dryRun && r.ids.length > 0
          ? ` sample=${r.ids.slice(0, 3).join(",")}`
          : ""),
    );
  }

  const totalArchived = reports.reduce((s, r) => s + r.archived, 0);
  const totalMatched = reports.reduce((s, r) => s + r.matched, 0);
  logger.info(
    `archive-stale done: matched=${totalMatched} archived=${totalArchived} dry_run=${dryRun}`,
  );

  // Emit JSON to stdout so launchd logs are easily grep-able.
  console.log(
    JSON.stringify(
      {
        run_at: startedAt,
        dry_run: dryRun,
        total_matched: totalMatched,
        total_archived: totalArchived,
        rules: reports.map((r) => ({
          label: r.label,
          matched: r.matched,
          archived: r.archived,
        })),
      },
      null,
      2,
    ),
  );
}

// Only auto-run when invoked as a CLI. Tests import { sweep } from this
// module and must not trigger a full sweep + JSON-to-stdout on import.
if (import.meta.main) {
  main().catch((err) => {
    logger.error(`archive-stale failed: ${err}`);
    console.error(err);
    process.exit(1);
  });
}
