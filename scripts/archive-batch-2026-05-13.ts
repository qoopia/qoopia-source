#!/usr/bin/env bun
/**
 * archive-batch-2026-05-13.ts — one-off batch archive driven by Askhat's
 * directive 2026-05-13 (Telegram msg 2362 / msg 2364), executed by Alan.
 *
 * Purpose:
 *   Archive a hand-vetted list of 21 task notes that fell out of the
 *   Phase 1 audit (groups C+D+E of msg 2361):
 *     - Group C: 18 tasks with metadata.status in
 *       (done|cancelled|closed|completed) — auto-archive, no review.
 *     - Group D: 1 legacy "V2 compat" migration noise.
 *     - Group E: 2 stale 'todo' tasks with due < 2026-04-15 (manually
 *       reviewed by Askhat).
 *
 *   The Aidan-migration task (01KNT6CZ4G7E93D80RSHKCKXJY) that surfaced
 *   in the Dan/port-18792 false-positive check was already in Group C
 *   (status='done'), so the unique batch size is 21 — Askhat's "22"
 *   count in msg 2362 counted it twice. The script is idempotent so
 *   double-listing would have been safe, but transparency matters.
 *
 * Mechanism:
 *   Mirrors scripts/archive-stale.ts archive flow:
 *     1. SELECT id, json_extract(metadata,'$.status') for each target.
 *     2. If status is already 'archived', log "skipped" and continue.
 *     3. Else: UPDATE metadata via json_set, preserving previous_status
 *        (variant A) or omitting it when status was null (variant B —
 *        not expected for this batch but defensively handled).
 *
 *   IF YOU CHANGE THE ARCHIVE UPDATE LOGIC: update scripts/archive-
 *   stale.ts in lockstep. This is deliberate duplication: archive-stale
 *   is a weekly cron with rule-based candidates; this script is a one-
 *   off with a hand-list. Adding a CLI flag --ids to archive-stale was
 *   explicitly rejected (Askhat, msg 2364).
 *
 * Reversibility:
 *   The round-trip un-archive SQL is locked by tests/archive-stale-
 *   previous-status.test.ts test #3:
 *     UPDATE notes SET metadata = json_remove(
 *       json_set(metadata, '$.status',
 *                json_extract(metadata, '$.previous_status')),
 *       '$.previous_status'
 *     ) WHERE id = ?;
 *
 * Output:
 *   JSON to stdout: {archived: [...], skipped: [...], errors: [...]}
 *   plus a per-id before/after log line to stderr for the audit trail.
 *
 * Usage:
 *   bun run scripts/archive-batch-2026-05-13.ts | tee /tmp/archive-batch-2026-05-13.log
 */
import { db } from "../src/db/connection.ts";
import { logger } from "../src/utils/logger.ts";

/**
 * 21 unique note ids to archive. Comments record the source group and
 * the original status / a short text snippet so a future reader can
 * audit without diving back into the live DB.
 */
const ARCHIVE_IDS: string[] = [
  // Group C — done/cancelled (18 ids; ULIDs ascend by creation time)
  "01KMKRVYF77GVQPJV3JNYKSECP", // cancelled | #16 Cinco Ranch Rd — уже сдана
  "01KMKRVYF9H32B1T540QZDXWJ7", // done      | Stepper: GitHub public launch (Фаза 1)
  "01KMKRVYF95ZHX1N18XP8JKZ66", // cancelled | Fish Audio — оценка и тестирование
  "01KMKRVYF9BCQ016SW9DAQZ41X", // done      | Старый Mac Mini убрать из Tailscale
  "01KN7QY93Q5C37CS63PZRNZXPP", // done      | Портал франчайзи — MVP запущен
  "01KN7QY94QVV21YVMZH9YRBYCA", // done      | Канал Happy Life — запущен, AISAN подключён
  "01KN7QY959PJQC3K7F0697GDK1", // done      | Email для агентов — AgentMail подключён
  "01KN7QY95TEXAE2QC622EYWMCK", // done      | AISAN сервер — конфигурация исправлена
  "01KN7QZ36K03D3N0YWS13NN0EH", // cancelled | P&L аналитика по локациям
  "01KN7QZ372KZ5BGKHQV21JC1QJ", // done      | Ежедневный дайджест ОС в Happy Life
  "01KNPQVTQ085ZFZ69SK4TXJ4BN", // cancelled | [Новая] Поставка по возврату (отображение всех позиций)
  "01KNT6CM08AAKPE9ZX2R8WRP53", // done      | МИГРАЦИЯ Фаза 2: Перевод Aizek на Claude Code Subagent
  "01KNT6CZ4G7E93D80RSHKCKXJY", // done      | МИГРАЦИЯ Фаза 3: Перевод Aidan на Claude Code Subagent
  "01KPBDKP9YFPWG97YYDEMG1CY4", // done      | Реестр жалоб — второй обзвон
  "01KPBDKWHYBAE8RXE3AV2W4HE6", // done      | IVR — оптимизация аудио
  "01KPBDMH0VHXATCQWV9M1A81VJ", // done      | Вечерняя смена — +1-2 оператора (17:00-21:00)
  "01KPBDMR8F280GJB83EQESTVCE", // cancelled | Сессия по стандартам для франчайзи
  "01KPBDMYX36PFRSF7N5FYZEQ6W", // cancelled | Промокод "Сәлем" -500₸

  // Group D — legacy V2 compat noise (1 id)
  "01KNZS30SB2K4W67VR1676P725", // null      | V2 compat created task via legacy create tool

  // Group E — stale 'todo' with due < 2026-04-15, reviewed by Askhat (2 ids)
  "01KN742ZJT2H88R00TVBBKPDZF", // todo      | [Новая] ФЛК/подсказки для выбора склада при списании (due 2026-04-10)
  "01KP2FFTS9B326ASMM9NC93H43", // todo      | Проверить сессии alan/aizek-2026-04-13 на реальные записи (due 2026-04-13)
];

interface BatchReport {
  archived: string[];
  skipped: string[];
  errors: Array<{ id: string; error: string }>;
}

function archiveBatch(ids: string[]): BatchReport {
  const archived: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  // before/after probes: same payload shape as archive-stale.ts logging
  // so audit greps can match across both.
  const probeStmt = db.prepare(
    `SELECT id, type, json_extract(metadata, '$.status') AS status,
            SUBSTR(text, 1, 60) AS snippet
       FROM notes
      WHERE id = ? AND deleted_at IS NULL`,
  );

  // Two prepared statements — mirror of scripts/archive-stale.ts sweep().
  // Variant A: note had non-null $.status → preserve into $.previous_status.
  const updateStmtWithPrev = db.prepare(
    `UPDATE notes
       SET metadata = json_set(
             COALESCE(metadata, '{}'),
             '$.status', 'archived',
             '$.previous_status', ?,
             '$.archived_at', ?,
             '$.archived_by', 'archive-batch-2026-05-13.ts'
           ),
           updated_at = ?
     WHERE id = ?`,
  );
  // Variant B: $.status was null → do NOT introduce $.previous_status.
  const updateStmtNoPrev = db.prepare(
    `UPDATE notes
       SET metadata = json_set(
             COALESCE(metadata, '{}'),
             '$.status', 'archived',
             '$.archived_at', ?,
             '$.archived_by', 'archive-batch-2026-05-13.ts'
           ),
           updated_at = ?
     WHERE id = ?`,
  );

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const tx = db.transaction((targetIds: string[]) => {
    for (const id of targetIds) {
      const before = probeStmt.get(id) as
        | { id: string; type: string; status: string | null; snippet: string }
        | undefined;

      if (!before) {
        errors.push({ id, error: "not found or soft-deleted" });
        console.error(`  ${id}: ERROR not_found_or_deleted`);
        continue;
      }

      if (before.status === "archived") {
        skipped.push(id);
        console.error(
          `  ${id}: skipped (already archived) type=${before.type}`,
        );
        continue;
      }

      try {
        if (before.status != null) {
          updateStmtWithPrev.run(before.status, now, now, id);
        } else {
          updateStmtNoPrev.run(now, now, id);
        }

        const after = probeStmt.get(id) as
          | { id: string; type: string; status: string | null; snippet: string }
          | undefined;

        archived.push(id);
        console.error(
          `  ${id}: archived | type=${before.type} | ` +
            `${before.status ?? "(null)"} → ${after?.status ?? "(?)"} | ` +
            `"${before.snippet.replace(/\n/g, " ")}"`,
        );
      } catch (err) {
        errors.push({ id, error: (err as Error).message });
        console.error(`  ${id}: ERROR ${(err as Error).message}`);
      }
    }
  });

  tx(ids);

  return { archived, skipped, errors };
}

function main() {
  const startedAt = new Date().toISOString();
  logger.info(
    `archive-batch-2026-05-13 starting at ${startedAt} (${ARCHIVE_IDS.length} candidates)`,
  );
  console.error(`--- archive-batch-2026-05-13 begin (${startedAt}) ---`);

  // Guard: refuse to run if the list got mutated to something unexpected.
  if (ARCHIVE_IDS.length !== 21) {
    logger.error(
      `aborting: expected exactly 21 candidates, got ${ARCHIVE_IDS.length}`,
    );
    process.exit(2);
  }

  const report = archiveBatch(ARCHIVE_IDS);

  console.error(
    `--- done: archived=${report.archived.length} ` +
      `skipped=${report.skipped.length} errors=${report.errors.length} ---`,
  );

  // JSON to stdout — easy for the decision-note to ingest verbatim.
  console.log(
    JSON.stringify(
      {
        run_at: startedAt,
        script: "scripts/archive-batch-2026-05-13.ts",
        total: ARCHIVE_IDS.length,
        archived: report.archived,
        skipped: report.skipped,
        errors: report.errors,
      },
      null,
      2,
    ),
  );

  // Non-zero exit if any errors so an automation runner notices.
  if (report.errors.length > 0) process.exit(1);
}

if (import.meta.main) {
  main();
}

// Exported for completeness / future audits — no tests required since
// the underlying SQL is already covered by archive-stale-previous-status.
export { ARCHIVE_IDS, archiveBatch };
