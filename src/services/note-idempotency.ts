/**
 * Идемпотентный replay `note_create` (ТЗ §6.3, §10.4, §11; матрица §8).
 *
 * Спецификация требует, чтобы идентичный повтор возвращал ТУ ЖЕ ноту без
 * второй вставки и без второй супersession предшественника, а тот же ключ с
 * ИНЫМ payload давал `CONFLICT` / `IDEMPOTENCY_MISMATCH`. Отдельного
 * механизма у `note_create` не было — при повторе MCP-вызова создавалась
 * вторая нота B, а условный UPDATE закрывал бы предшественника повторно (или
 * возвращал STALE_VERSION вместо no-op).
 *
 * Реестр — существующая с миграции 001 таблица `idempotency_keys`
 * (`key_hash` PK, `response`, `expires_at`), уже подметаемая retention.
 * Хранится хеш запроса и сериализованный результат; сам payload и текст ноты
 * в реестр не попадают.
 *
 * Ключ скоупится (workspace_id, agent_id, key): агент не может ни подсмотреть,
 * ни занять чужой ключ.
 */
import { createHash } from "node:crypto";
import { db } from "../db/connection.ts";
import { QoopiaError, throwCoded } from "../utils/errors.ts";

/** Тот же алфавит, что у AgentComm-ключей: буквы, цифры, `. _ : -`. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** Сколько живёт запись реестра. Подчищается `retention.ts`. */
const NOTE_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeNoteIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (raw.length === 0) return null;
  if (!IDEMPOTENCY_KEY.test(raw)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "idempotency_key must be 1-128 characters: letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  return raw;
}

/** Детерминированная сериализация: порядок ключей объекта не влияет на хеш. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function noteIdempotencyKeyHash(
  workspaceId: string,
  agentId: string,
  key: string,
): string {
  return createHash("sha256")
    .update(`note_create/v1\u0000${workspaceId}\u0000${agentId}\u0000${key}`)
    .digest("hex");
}

/** Хеш семантического содержимого запроса — им детектируется reuse ключа. */
export function noteRequestHash(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`note_create-request/v1\u0000${stableStringify(payload)}`)
    .digest("hex");
}

interface StoredEnvelope {
  request_hash: string;
  result: Record<string, unknown>;
}

/**
 * Найти прошлый ответ по ключу.
 *
 * Совпал хеш запроса — возвращается сохранённый результат (полный no-op).
 * Не совпал — `CONFLICT` с кодом `IDEMPOTENCY_MISMATCH` (§8).
 */
export function lookupNoteIdempotency(
  keyHash: string,
  requestHash: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT response FROM idempotency_keys WHERE key_hash = ?`)
    .get(keyHash) as { response: string } | undefined;
  if (!row) return null;
  let envelope: StoredEnvelope;
  try {
    envelope = JSON.parse(row.response) as StoredEnvelope;
  } catch {
    throw new QoopiaError("CONFLICT", "idempotency record is unreadable");
  }
  if (envelope.request_hash !== requestHash) idempotencyMismatch();
  return envelope.result;
}

/** Тот же ключ с иным payload (§8). Используется и ручной политикой памяти. */
export function idempotencyMismatch(): never {
  return throwCoded("CONFLICT", "IDEMPOTENCY_MISMATCH", "idempotency_key was already used for a different note_create payload");
}

/** Записать ответ. Вызывается внутри транзакции создания ноты. */
export function storeNoteIdempotency(
  keyHash: string,
  workspaceId: string,
  requestHash: string,
  result: Record<string, unknown>,
): void {
  const envelope: StoredEnvelope = { request_hash: requestHash, result };
  db.prepare(
    `INSERT INTO idempotency_keys (key_hash, workspace_id, response, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    keyHash,
    workspaceId,
    JSON.stringify(envelope),
    new Date(Date.now() + NOTE_IDEMPOTENCY_TTL_MS).toISOString(),
  );
}
