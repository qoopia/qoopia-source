/**
 * migrate-033-preflight.ts — Phase A (pure read) + Phase B (durable staging)
 * протокола миграции 033 (ТЗ §5.1, R1/R6).
 *
 *   Phase A  классифицирует supersedes-граф system-level классификатором
 *            `classifySupersedeComponents` (без AuthContext, без visibility)
 *            и пишет `migration-033-report.json`. Ни одной записи в БД.
 *   Phase B  в одной транзакции создаёт staging-таблицы и наполняет их
 *            ПРЕДВЫЧИСЛЕННЫМИ в TypeScript целыми epoch-ms и производными
 *            ISO (R3/R4) — миграция 033 не считает время сама.
 *
 * Инвариант R1: любой сбой Phase A или записи отчёта оставляет БД нетронутой.
 * Phase B выполняется только после успешной записи отчёта.
 *
 * Class B: фактический запуск против рабочей БД — только по owner GO.
 *
 * Пример:
 *   bun run scripts/migrate-033-preflight.ts \
 *     --db /path/to/qoopia.db --evidence-dir release-evidence/<ts>-<sha>
 */
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { DEFAULT_MAX_COMPONENT_SIZE } from "../src/services/temporal-migration.ts";
import {
  buildStagingPlan,
  runPhaseA,
  stagingPlanDigest,
  type PreflightReport,
  type StagingPlan,
} from "../src/db/migration-033-plan.ts";
import { supersedeGraphDigest } from "../src/db/migration-033-gate.ts";

// Phase A и построение плана живут в `src/db/migration-033-plan.ts`: тот же
// код обязан быть доступен gate'у миграции для пересчёта и построчной сверки.
export {
  buildStagingPlan,
  readStagingPlan,
  recomputeStagingPlan,
  runPhaseA,
  stagingPlanDigest,
  type LinearTargetRow,
  type PreflightReport,
  type PreflightReportComponent,
  type SkippedRow,
  type StagingPlan,
} from "../src/db/migration-033-plan.ts";

export const REPORT_FILENAME = "migration-033-report.json";

/** Записать отчёт Phase A. Вызывается ДО любой мутации БД (R1). */
export function writeReport(evidenceDir: string, report: PreflightReport): string {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const target = path.join(evidenceDir, REPORT_FILENAME);
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return target;
}

/**
 * Phase B. Пишет durable staging.
 *
 * Staging пересоздаётся С НУЛЯ (`DROP` + `CREATE`, обычный `INSERT`), а не
 * дополняется `IF NOT EXISTS` + `INSERT OR REPLACE`: иначе строки прошлого
 * прогона по узлам, выбывшим из графа, пережили бы новый preflight и
 * забэкфиллились бы миграцией. Вместе со staging фиксируется дайджест
 * supersedes-графа — gate миграции сверяет его с живым графом и отказывается
 * работать по устаревшей классификации.
 *
 * Транзакцией управляет вызывающий (`runPreflight` держит одну
 * `BEGIN IMMEDIATE` на Phase A + отчёт + Phase B), поэтому здесь своей
 * транзакции нет — вложенная скрыла бы откат всего снимка.
 */
export function runPhaseB(
  db: Database,
  plan: StagingPlan,
  graphDigest: string,
  maxComponentSize = DEFAULT_MAX_COMPONENT_SIZE,
): void {
  db.run(`DROP TABLE IF EXISTS mig033_linear_targets`);
  db.run(`DROP TABLE IF EXISTS mig033_skipped`);
  db.run(`DROP TABLE IF EXISTS mig033_staging_meta`);
  db.run(`CREATE TABLE mig033_linear_targets (
      note_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      invalidated_at_ms INTEGER NOT NULL,
      valid_until_ms    INTEGER NOT NULL,
      invalidated_at_iso TEXT NOT NULL,
      valid_until_iso    TEXT NOT NULL,
      PRIMARY KEY (note_id, workspace_id))`);
  db.run(`CREATE TABLE mig033_skipped (
      note_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      backfill_class TEXT NOT NULL, skipped_reason TEXT NOT NULL,
      PRIMARY KEY (note_id, workspace_id))`);
  db.run(`CREATE TABLE mig033_staging_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const insertTarget = db.query(
    `INSERT INTO mig033_linear_targets
       (note_id, workspace_id, invalidated_at_ms, valid_until_ms,
        invalidated_at_iso, valid_until_iso)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of plan.linear_targets) {
    insertTarget.run(
      row.note_id,
      row.workspace_id,
      row.invalidated_at_ms,
      row.valid_until_ms,
      row.invalidated_at_iso,
      row.valid_until_iso,
    );
  }
  const insertSkipped = db.query(
    `INSERT INTO mig033_skipped
       (note_id, workspace_id, backfill_class, skipped_reason)
     VALUES (?, ?, ?, ?)`,
  );
  for (const row of plan.skipped) {
    insertSkipped.run(row.note_id, row.workspace_id, row.backfill_class, row.skipped_reason);
  }
  const insertMeta = db.query(
    `INSERT INTO mig033_staging_meta (key, value) VALUES (?, ?)`,
  );
  insertMeta.run("graph_digest", graphDigest);
  // Дайджест по КАЖДОЙ строке и КАЖДОМУ полю плана. Gate пересчитывает план
  // из живого графа и сверяет оба дайджеста, поэтому подмена класса или поля
  // уже записанной staging не проходит.
  insertMeta.run("plan_digest", stagingPlanDigest(plan));
  insertMeta.run("max_component_size", String(maxComponentSize));
  insertMeta.run("linear_target_count", String(plan.linear_targets.length));
  insertMeta.run("skipped_count", String(plan.skipped.length));
}

export interface PreflightArgs {
  db: string;
  evidenceDir: string;
  maxComponentSize: number;
  phase: "a" | "ab";
}

export function parsePreflightArgs(argv: string[]): PreflightArgs {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const [flag, inline] = token.slice(2).split("=", 2);
    args[flag!] = inline ?? argv[++index] ?? "";
  }
  if (!args.db) throw new Error("--db <path to qoopia.db> is required");
  if (!args["evidence-dir"]) throw new Error("--evidence-dir <dir> is required");
  const phase = (args.phase ?? "ab").toLowerCase();
  if (phase !== "a" && phase !== "ab") throw new Error("--phase must be 'a' or 'ab'");
  return {
    db: args.db,
    evidenceDir: args["evidence-dir"]!,
    maxComponentSize: args["max-component-size"]
      ? Number(args["max-component-size"])
      : DEFAULT_MAX_COMPONENT_SIZE,
    phase,
  };
}

export function runPreflight(args: PreflightArgs): {
  report: string;
  staged: number;
  graph_digest: string;
} {
  // Phase A открывается строго read-only: физическая гарантия «нет мутации».
  if (args.phase === "a") {
    const db = new Database(args.db, { readonly: true });
    try {
      const report = runPhaseA(db, args.maxComponentSize);
      return {
        report: writeReport(args.evidenceDir, report),
        staged: 0,
        graph_digest: supersedeGraphDigest(db),
      };
    } finally {
      db.close();
    }
  }

  const db = new Database(args.db, { readwrite: true });
  try {
    // ОДИН согласованный снимок на Phase A + отчёт + Phase B. `BEGIN
    // IMMEDIATE` берёт RESERVED-блокировку сразу, поэтому граф не может
    // сдвинуться между классификацией, отчётом и наполнением staging — иначе
    // отчёт описывал бы один граф, а staging соответствовала другому.
    db.run("BEGIN IMMEDIATE");
    try {
      const report = runPhaseA(db, args.maxComponentSize);
      const digest = supersedeGraphDigest(db);
      // Отчёт пишется внутри того же снимка и ДО любой мутации: его сбой
      // откатывает транзакцию и оставляет БД нетронутой (R1).
      const reportPath = writeReport(args.evidenceDir, report);
      const plan = buildStagingPlan(db, report);
      runPhaseB(db, plan, digest, args.maxComponentSize);
      db.run("COMMIT");
      return {
        report: reportPath,
        staged: plan.linear_targets.length + plan.skipped.length,
        graph_digest: digest,
      };
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const args = parsePreflightArgs(process.argv.slice(2));
    const result = runPreflight(args);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        report: result.report,
        staged_rows: result.staged,
        graph_digest: result.graph_digest,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`preflight failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
