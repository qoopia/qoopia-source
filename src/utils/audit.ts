/**
 * Structured JSON-line audit log для security-событий.
 *
 * Пишет по одному JSON-объекту на строку в $QOOPIA_LOG_DIR/audit.log. Формат
 * совместим с jq / logstash. Высокочастотные события (успешные auth по
 * каждому request) НЕ логируются — только security-relevant: отказы, rate-limit,
 * workspace-mismatch, admin-secret fails, OAuth grants.
 *
 * Писатель append-only, synchronous write (volume низкий, синхронность упрощает
 * отладку инцидента — событие уже на диске к моменту отправки ответа).
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

export type AuditEvent =
  | "auth_failure"
  | "admin_secret_fail"
  | "workspace_mismatch"
  | "ingest_forbidden"
  | "rate_limit_trigger"
  | "oauth_register"
  | "oauth_token"
  | "oauth_revoke"
  | "oauth_consent";

export type AuditResult = "allow" | "deny" | "error";

export interface AuditRecord {
  ts: string;
  event: AuditEvent;
  result: AuditResult;
  ip?: string;
  workspace_id?: string;
  agent_id?: string;
  scope?: string;
  detail?: string;
}

let auditPath: string | null = null;
let warnedOnError = false;

function resolveAuditPath(): string {
  if (auditPath) return auditPath;
  try {
    fs.mkdirSync(env.LOG_DIR, { recursive: true });
  } catch {
    // best-effort; if dir creation fails, writes will also fail and we'll warn once.
  }
  auditPath = path.join(env.LOG_DIR, "audit.log");
  return auditPath;
}

/**
 * Записать security-событие в audit.log. Не бросает — сбои записи логируются
 * один раз (чтобы не захламлять логи), само приложение продолжает работать.
 */
export function audit(rec: Omit<AuditRecord, "ts">): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n";
  try {
    fs.appendFileSync(resolveAuditPath(), line, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    if (!warnedOnError) {
      warnedOnError = true;
      logger.error("audit log write failed (further errors suppressed)", { error: String(err) });
    }
  }
}
