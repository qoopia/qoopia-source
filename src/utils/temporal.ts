/**
 * V4.1 bi-temporal facts — единый epoch-ms инвариант (ТЗ §3.3, R3/R4).
 *
 * epoch-ms = целое число миллисекунд от Unix epoch в UTC.
 *
 * Конвертация детерминирована и НЕ использует `julianday`:
 *   ISO -> ms   `Date.parse(canonicalIso)`
 *   ms  -> ISO  `new Date(ms).toISOString()`
 *
 * Всякое сравнение, сортировка и агрегация (`max`/`min`) выполняются на
 * числовом epoch-ms; ISO для отображения производится из результата одним
 * форматтером. Строковый MAX/MIN смешанных ISO запрещён (R4).
 */
import { QoopiaError } from "./errors.ts";

/** Feature flag. Default OFF — включение только по owner GO (Class B). */
export const BITEMPORAL_FLAG = "QOOPIA_V4_BITEMPORAL";

/**
 * Читается на каждом вызове, а не на загрузке модуля: тот же приём, что у
 * `getRecallMode()`/`rrfK()`, иначе значение замерзает на процесс и тесты не
 * могут переключать режим.
 */
export function bitemporalEnabled(): boolean {
  const raw = process.env[BITEMPORAL_FLAG];
  return raw === "true" || raw === "1";
}

/**
 * Ошибка с кодом `FEATURE_DISABLED`. Форма повторяет уже существующий приём
 * в `recall/v4-pipeline.ts`, чтобы клиентский разбор ошибок не расходился.
 */
export function temporalFeatureDisabled(detail = BITEMPORAL_FLAG): never {
  const error = new QoopiaError("INVALID_INPUT", detail);
  (error as { code: string }).code = "FEATURE_DISABLED";
  throw error;
}

/** Ошибка оптимистической блокировки предшественника (ТЗ §8). */
export function staleVersion(message: string): never {
  const error = new QoopiaError("CONFLICT", message);
  (error as { code: string }).code = "STALE_VERSION";
  throw error;
}

/** Канонический (`…SSSZ`) и legacy (`…SZ`) UTC-формат. Только `Z`. */
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEGACY_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Разобрать ISO-момент в целые epoch-ms.
 *
 * Принимает канонический `…SSSZ` и legacy `…SZ` (без миллисекунд — они
 * доопределяются как `.000`, поэтому «один и тот же момент» в двух записях
 * даёт РАВНЫЙ epoch-ms). Любая другая форма, локальное время или смещение,
 * отличное от `Z`, — `INVALID_INPUT`.
 */
export function toEpochMs(value: unknown, field: string): number {
  if (typeof value !== "string" || (!CANONICAL_ISO.test(value) && !LEGACY_ISO.test(value))) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `${field} must be a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS[.mmm]Z)`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new QoopiaError("INVALID_INPUT", `${field} is not a parsable timestamp`);
  }
  // Roundtrip: отбрасывает синтаксически валидные, но несуществующие моменты
  // (2026-02-30T00:00:00Z и т.п.), которые Date.parse нормализует молча.
  if (new Date(ms).toISOString() !== canonicalize(value)) {
    throw new QoopiaError("INVALID_INPUT", `${field} is not a canonical UTC timestamp`);
  }
  return ms;
}

/** `…SZ` -> `…S.000Z`; канонический вход возвращается как есть. */
function canonicalize(value: string): string {
  return LEGACY_ISO.test(value) ? value.replace(/Z$/, ".000Z") : value;
}

/** Единый форматтер отображаемого ISO. Источник — только epoch-ms (R4). */
export function isoFromEpochMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    throw new QoopiaError("INVALID_INPUT", "epoch-ms must be a finite number");
  }
  return new Date(ms).toISOString();
}

/** Числовой максимум двух epoch-ms. Строкового сравнения ISO здесь нет (R4). */
export function maxEpochMs(a: number, b: number): number {
  return a > b ? a : b;
}

/** Числовой минимум двух epoch-ms. */
export function minEpochMs(a: number, b: number): number {
  return a < b ? a : b;
}

/**
 * `subject_key` (ТЗ §3.4): `[a-z0-9][a-z0-9._-]*`, 1–128 символов,
 * без молчаливого приведения регистра.
 */
const SUBJECT_KEY = /^[a-z0-9][a-z0-9._-]*$/;

export function assertSubjectKey(value: string): void {
  if (value.length < 1 || value.length > 128 || !SUBJECT_KEY.test(value)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "subject_key must match [a-z0-9][a-z0-9._-]* and be 1-128 chars",
    );
  }
}
