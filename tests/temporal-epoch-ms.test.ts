/**
 * ТЗ §10.5 (R3/R4) — единый epoch-ms инвариант.
 *
 * Проверяется: равенство TS `Date.parse` и SQL integer-метода миграции 025
 * на границах .001/.499/.500/.999 и на форме без миллисекунд; отображаемый
 * ISO производится ТОЛЬКО из ms; grep-gate «нет julianday в temporal-ms
 * путях» и «нет строкового MAX/MIN по ISO».
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  isoFromEpochMs,
  maxEpochMs,
  minEpochMs,
  toEpochMs,
} from "../src/utils/temporal.ts";
import { QoopiaError } from "../src/utils/errors.ts";
import {
  applyMigration033,
  buildPlanFixture,
  cleanupScratchRoots,
} from "./helpers/temporal-fixtures.ts";

afterAll(() => cleanupScratchRoots());

const BOUNDARIES = [
  "2026-03-01T12:00:00.001Z",
  "2026-03-01T12:00:00.499Z",
  "2026-03-01T12:00:00.500Z",
  "2026-03-01T12:00:00.999Z",
  "2026-03-01T12:00:00.000Z",
  "2026-03-01T12:00:00Z",
];

/** Точная копия SQL-выражения из 025/033. `julianday` не участвует. */
const SQL_MS = `CAST(strftime('%s', ?) AS INTEGER) * 1000
  + COALESCE(CAST(substr(strftime('%f', ?), 4, 3) AS INTEGER), 0) AS ms`;

describe("R3 epoch-ms parity between TypeScript and SQL", () => {
  test("boundary suite: Date.parse equals the migration-025 integer method", () => {
    const db = new Database(":memory:");
    const statement = db.query(`SELECT ${SQL_MS}`);
    for (const value of BOUNDARIES) {
      const sqlMs = (statement.get(value, value) as { ms: number }).ms;
      expect(sqlMs).toBe(Date.parse(value));
      expect(toEpochMs(value, "boundary")).toBe(sqlMs);
    }
  });

  test("a moment with .000 and the no-ms form share one epoch-ms", () => {
    expect(toEpochMs("2026-03-01T12:00:00Z", "x")).toBe(
      toEpochMs("2026-03-01T12:00:00.000Z", "x"),
    );
  });

  test("display ISO is derived from epoch-ms by a single formatter", () => {
    for (const value of BOUNDARIES) {
      const ms = toEpochMs(value, "x");
      expect(isoFromEpochMs(ms)).toBe(new Date(ms).toISOString());
      expect(Date.parse(isoFromEpochMs(ms))).toBe(ms);
    }
  });

  test("max/min operate numerically, never on ISO strings", () => {
    // Строковое сравнение дало бы обратный порядок для смешанных форм.
    const noMs = toEpochMs("2026-03-01T12:00:00Z", "a");
    const fractional = toEpochMs("2026-03-01T12:00:00.001Z", "b");
    expect(maxEpochMs(noMs, fractional)).toBe(fractional);
    expect(minEpochMs(noMs, fractional)).toBe(noMs);
    // Демонстрация, ПОЧЕМУ строковое сравнение запрещено (R4): лексикографически
    // форма без миллисекунд «больше» той же точки с `.001`.
    const noMsIso: string = "2026-03-01T12:00:00Z";
    const fractionalIso: string = "2026-03-01T12:00:00.001Z";
    expect(noMsIso > fractionalIso).toBe(true);
    expect(noMs < fractional).toBe(true);
  });

  test("non-canonical, non-UTC and impossible timestamps are rejected", () => {
    for (const value of [
      "2026-03-01 12:00:00Z",
      "2026-03-01T12:00:00+01:00",
      "2026-03-01T12:00:00",
      "2026-02-30T00:00:00Z",
      "2026-03-01T12:00:00.1Z",
      "",
      42 as unknown as string,
    ]) {
      expect(() => toEpochMs(value, "field")).toThrow(QoopiaError);
    }
  });
});

describe("R4 legacy backfill boundary — no-ms valid_from before fractional relation", () => {
  test("Date.parse(valid_until) === valid_until_ms after the migration", () => {
    const { scratch } = buildPlanFixture({
      noteCreatedAt: "2026-03-01T12:00:00Z",
      relationCreatedAt: "2026-03-01T12:00:00.499Z",
    });
    applyMigration033(scratch.db);
    const row = scratch.db
      .query(
        `SELECT valid_from, valid_from_ms, valid_until, valid_until_ms,
                invalidated_at, invalidated_at_ms
           FROM notes WHERE id = 'bnd-a'`,
      )
      .get() as Record<string, any>;
    expect(row.valid_from).toBe("2026-03-01T12:00:00Z");
    expect(row.valid_from_ms).toBe(Date.parse("2026-03-01T12:00:00Z"));
    // valid_until = max(valid_from_ms, invalidated_at_ms) ЧИСЛЕННО.
    expect(row.invalidated_at_ms).toBe(Date.parse("2026-03-01T12:00:00.499Z"));
    expect(row.valid_until_ms).toBe(row.invalidated_at_ms);
    expect(Date.parse(row.valid_until)).toBe(row.valid_until_ms);
    expect(row.valid_until).toBe("2026-03-01T12:00:00.499Z");
    expect(row.invalidated_at).toBe(new Date(row.invalidated_at_ms).toISOString());
  });

  test("every boundary fraction survives the round trip through staging", () => {
    for (const fraction of ["001", "499", "500", "999"]) {
      const relationAt = `2026-03-01T12:00:00.${fraction}Z`;
      const { scratch } = buildPlanFixture({
        noteCreatedAt: "2026-03-01T12:00:00Z",
        relationCreatedAt: relationAt,
      });
      applyMigration033(scratch.db);
      const row = scratch.db
        .query(`SELECT invalidated_at, invalidated_at_ms FROM notes WHERE id = 'bnd-a'`)
        .get() as { invalidated_at: string; invalidated_at_ms: number };
      expect(row.invalidated_at_ms).toBe(Date.parse(relationAt));
      expect(row.invalidated_at).toBe(relationAt);
    }
  });
});

/** Пути, где время обязано быть целым epoch-ms (R3/R4). */
const TEMPORAL_PATHS = [
  "src/utils/temporal.ts",
  "src/services/temporal-migration.ts",
  "src/services/note-temporal.ts",
  "src/services/recall/temporal-filter.ts",
  "src/db/migration-033-gate.ts",
  "scripts/migrate-033-preflight.ts",
  "migrations/033-notes-bitemporal.sql",
  "migrations/rollback/033-notes-bitemporal.rollback.sql",
];

/**
 * Комментарии сознательно называют запрет по имени («julianday запрещён»),
 * поэтому grep-gate работает по КОДУ: блочные и строчные комментарии TS и
 * `--`-комментарии SQL вырезаются.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

function readTemporalSources(): Array<{ file: string; source: string }> {
  const root = path.resolve(import.meta.dir, "..");
  return TEMPORAL_PATHS.map((file) => ({
    file,
    source: stripComments(fs.readFileSync(path.join(root, file), "utf8")),
  }));
}

describe("grep gates", () => {
  test("no julianday anywhere in the temporal-ms paths (R3)", () => {
    const offenders = readTemporalSources()
      .filter(({ source }) => /julianday/i.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("no string MAX/MIN over ISO columns in the temporal paths (R4)", () => {
    const isoColumns = /\b(MAX|MIN)\s*\(\s*[A-Za-z_.]*(valid_from|valid_until|invalidated_at|created_at|updated_at)\s*\)/gi;
    const offenders: string[] = [];
    for (const { file, source } of readTemporalSources()) {
      for (const match of source.matchAll(isoColumns)) {
        // Агрегаты по целочисленным *_ms допустимы; по ISO-колонкам — нет.
        if (!match[0].includes("_ms")) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the migration derives created_at_ms with the 025 integer method", () => {
    const root = path.resolve(import.meta.dir, "..");
    const sql = fs.readFileSync(path.join(root, "migrations/033-notes-bitemporal.sql"), "utf8");
    expect(sql).toContain("CAST(strftime('%s', created_at) AS INTEGER) * 1000");
    expect(sql).toContain("substr(strftime('%f', created_at), 4, 3)");
  });
});
