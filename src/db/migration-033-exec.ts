/**
 * Failure-atomic исполнение миграции 033 (ТЗ §5.1 Phase C, R1/R5).
 *
 * ПОЧЕМУ отдельный раннер. `bun:sqlite` `db.exec(sql)` на МНОГОоператорной
 * строке пробрасывает только ошибки подготовки и МОЛЧА проглатывает ошибки
 * времени исполнения — `CHECK`, `RAISE(ABORT)` из триггера, нарушение FK
 * (проверено на bun 1.3.14 / SQLite 3.53). Из-за этого сбой ВНУТРИ Phase C
 * (например, строка `mig033_skipped`, ссылающаяся на несуществующую ноту,
 * роняет триггер `ntp_ws_consistency_ins`) не прерывал бы миграцию: скрипт
 * доходил до `DROP TABLE`+`schema_versions(33)`, и база оставалась в
 * полу-мигрированном состоянии с пустым provenance. Это ломало R1 и
 * обесценивало R5.
 *
 * Здесь скрипт разбирается на отдельные операторы и исполняется по одному
 * через `db.run`, поэтому ЛЮБАЯ ошибка времени исполнения выбрасывается и
 * откатывает транзакцию вызывающего. Дополнительно, ПЕРЕД записью
 * `schema_versions(33)` и в той же транзакции, проверяются постусловия
 * Phase C: без них молчаливо-успешный, но неполный backfill всё ещё мог бы
 * записать версию схемы.
 */
import type { Database } from "bun:sqlite";

/** Признак «оператор — тело триггера», у которого `;` не терминатор. */
const TRIGGER_HEAD = /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const TRIGGER_TAIL = /\bEND\s*$/i;
const SCHEMA_VERSION_INSERT = /\bINSERT\s+INTO\s+schema_versions\b/i;

/** Убрать комментарии — только для решения «закончился ли оператор». */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Разбить SQL-скрипт на отдельные операторы.
 *
 * Учитываются строковые литералы (`'…''…'`), идентификаторы в кавычках,
 * построчные и блочные комментарии, а также тела триггеров
 * `CREATE TRIGGER … BEGIN … END;`, внутри которых `;` терминатором не является.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      current += char;
      index++;
      while (index < sql.length) {
        current += sql[index];
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            current += sql[index + 1];
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") current += sql[index++];
      continue;
    }
    if (char === "/" && next === "*") {
      current += "/*";
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        current += sql[index++];
      }
      current += "*/";
      index += 2;
      continue;
    }
    if (char === ";") {
      const body = stripComments(current).trim();
      // Внутри тела триггера `;` разделяет вложенные операторы, а не сам
      // `CREATE TRIGGER`: терминатор — только `;` сразу после `END`.
      if (TRIGGER_HEAD.test(body) && !TRIGGER_TAIL.test(body)) {
        current += char;
        index++;
        continue;
      }
      if (body.length > 0) statements.push(current.trim());
      current = "";
      index++;
      continue;
    }
    current += char;
    index++;
  }
  if (stripComments(current).trim().length > 0) statements.push(current.trim());
  return statements;
}

export interface Migration033Snapshot {
  linear_target_count: number;
  skipped_count: number;
  linear_target_ids: string[];
  skipped_ids: string[];
}

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) != null
  );
}

/**
 * Снимок ожиданий Phase C. Снимается ДО исполнения скрипта, потому что тот
 * дропает staging до записи `schema_versions`; проверять постусловия иначе
 * было бы не с чем.
 */
export function captureMigration033Snapshot(db: Database): Migration033Snapshot {
  const linear = tableExists(db, "mig033_linear_targets")
    ? (db
        .query(`SELECT note_id FROM mig033_linear_targets ORDER BY note_id`)
        .all() as Array<{ note_id: string }>)
    : [];
  const skipped = tableExists(db, "mig033_skipped")
    ? (db
        .query(`SELECT note_id FROM mig033_skipped ORDER BY note_id`)
        .all() as Array<{ note_id: string }>)
    : [];
  return {
    linear_target_count: linear.length,
    skipped_count: skipped.length,
    linear_target_ids: linear.map((row) => row.note_id),
    skipped_ids: skipped.map((row) => row.note_id),
  };
}

const REQUIRED_COLUMNS = [
  "valid_from",
  "valid_until",
  "invalidated_at",
  "subject_key",
  "supersedes_id",
  "created_at_ms",
  "valid_from_ms",
  "valid_until_ms",
  "invalidated_at_ms",
] as const;

const REQUIRED_INDEXES = [
  "idx_notes_current_ws",
  "idx_notes_current_ws_type",
  "idx_notes_valid_ms",
  "idx_notes_known_ms",
  "idx_notes_subject_valid",
  "idx_notes_supersedes_id",
  "idx_ntp_ws",
] as const;

const REQUIRED_TRIGGERS = ["ntp_ws_consistency_ins", "ntp_ws_consistency_upd"] as const;

function fail(message: string): never {
  throw new Error(`033-notes-bitemporal.sql postcondition failed: ${message}`);
}

function count(db: Database, sql: string, ...params: unknown[]): number {
  return (db.query(sql).get(...(params as never[])) as { c: number }).c;
}

/**
 * Постусловия Phase C. Выполняются В ТОЙ ЖЕ транзакции строго ДО записи
 * `schema_versions(33)`. Любой провал бросает, транзакция откатывается,
 * версия схемы не пишется, `notes` остаётся неизменной.
 */
export function assertMigration033Postconditions(
  db: Database,
  snapshot: Migration033Snapshot,
): void {
  const columns = new Set(
    (db.query(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const column of REQUIRED_COLUMNS) {
    if (!columns.has(column)) fail(`notes.${column} is missing`);
  }

  if (!tableExists(db, "note_temporal_provenance")) fail("note_temporal_provenance is missing");
  for (const trigger of REQUIRED_TRIGGERS) {
    const found = db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
      .get(trigger);
    if (!found) fail(`trigger ${trigger} is missing`);
  }
  for (const index of REQUIRED_INDEXES) {
    const found = db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(index);
    if (!found) fail(`index ${index} is missing`);
  }

  // R1: инвариант «valid_from_ms IS NULL = 0» и его предпосылка created_at_ms.
  const nullCreated = count(db, `SELECT COUNT(*) AS c FROM notes WHERE created_at_ms IS NULL`);
  if (nullCreated !== 0) fail(`${nullCreated} notes rows still have created_at_ms IS NULL`);
  const nullValidFrom = count(db, `SELECT COUNT(*) AS c FROM notes WHERE valid_from_ms IS NULL`);
  if (nullValidFrom !== 0) fail(`${nullValidFrom} notes rows still have valid_from_ms IS NULL`);

  // Каждая staged-строка обязана иметь provenance ровно своего класса.
  const provenanceTotal = count(db, `SELECT COUNT(*) AS c FROM note_temporal_provenance`);
  const expectedTotal = snapshot.linear_target_count + snapshot.skipped_count;
  if (provenanceTotal !== expectedTotal) {
    fail(
      `note_temporal_provenance holds ${provenanceTotal} rows, staging expected ${expectedTotal}`,
    );
  }
  const linearProvenance = count(
    db,
    `SELECT COUNT(*) AS c FROM note_temporal_provenance WHERE backfill_class = 'linear'`,
  );
  if (linearProvenance !== snapshot.linear_target_count) {
    fail(
      `linear provenance rows = ${linearProvenance}, staged linear targets = ${snapshot.linear_target_count}`,
    );
  }
  const skippedProvenance = count(
    db,
    `SELECT COUNT(*) AS c FROM note_temporal_provenance WHERE skipped_reason IS NOT NULL`,
  );
  if (skippedProvenance !== snapshot.skipped_count) {
    fail(
      `skipped provenance rows = ${skippedProvenance}, staged skipped rows = ${snapshot.skipped_count}`,
    );
  }

  const missing = db
    .query(
      `SELECT COUNT(*) AS c FROM note_temporal_provenance p
        WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = p.note_id
                            AND n.workspace_id = p.workspace_id)`,
    )
    .get() as { c: number };
  if (missing.c !== 0) fail(`${missing.c} provenance rows do not match notes(id, workspace_id)`);

  // Каждый linear-target закрыт; ни один skipped-узел не тронут (R1).
  for (const noteId of snapshot.linear_target_ids) {
    const row = db
      .query(
        `SELECT invalidated_at_ms, invalidated_at, valid_until_ms, valid_until
           FROM notes WHERE id = ?`,
      )
      .get(noteId) as
      | {
          invalidated_at_ms: number | null;
          invalidated_at: string | null;
          valid_until_ms: number | null;
          valid_until: string | null;
        }
      | undefined;
    if (!row) fail(`staged linear target ${noteId} is not present in notes`);
    if (row.invalidated_at_ms === null || row.invalidated_at === null) {
      fail(`staged linear target ${noteId} was not closed (invalidated_at is NULL)`);
    }
    if (row.valid_until_ms === null || row.valid_until === null) {
      fail(`staged linear target ${noteId} has no valid_until`);
    }
  }
  for (const noteId of snapshot.skipped_ids) {
    const row = db
      .query(`SELECT invalidated_at_ms FROM notes WHERE id = ?`)
      .get(noteId) as { invalidated_at_ms: number | null } | undefined;
    if (!row) fail(`staged skipped note ${noteId} is not present in notes`);
    if (row.invalidated_at_ms !== null) {
      fail(`skipped note ${noteId} was mutated by the migration (conservative rule, R1)`);
    }
  }

  // Staging обязана быть снята — иначе повторный прогон принял бы её за свежую.
  for (const table of ["mig033_linear_targets", "mig033_skipped", "mig033_staging_meta"]) {
    if (tableExists(db, table)) fail(`staging table ${table} still exists`);
  }
}

/**
 * Исполнить Phase C оператор за оператором с пробросом ошибок исполнения и
 * проверкой постусловий перед `schema_versions(33)`.
 *
 * Вызывается ТОЛЬКО внутри транзакции вызывающего.
 */
export function applyMigration033Sql(db: Database, sql: string): void {
  const snapshot = captureMigration033Snapshot(db);
  let asserted = false;
  for (const statement of splitSqlStatements(sql)) {
    if (!asserted && SCHEMA_VERSION_INSERT.test(stripComments(statement))) {
      assertMigration033Postconditions(db, snapshot);
      asserted = true;
    }
    db.run(statement);
  }
  if (!asserted) assertMigration033Postconditions(db, snapshot);
}
