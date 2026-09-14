import os from "node:os";
import { validateRuntimeConfiguration } from "./runtime-config.ts";

/** Shared boolean parsing: deployed installations historically use both 1 and true. */
export function envFlag(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function requireInt(
  value: string | undefined,
  name: string,
  defaultVal: number,
): number {
  if (value === undefined || value === "") return defaultVal;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Invalid numeric env var ${name}=${value} — expected integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid numeric env var ${name}=${value} — expected safe integer`);
  }
  return parsed;
}

function requirePositiveInt(
  value: string | undefined,
  name: string,
  defaultVal: number,
): number {
  const parsed = requireInt(value, name, defaultVal);
  if (parsed < 1) {
    throw new Error(`Invalid numeric env var ${name}=${parsed} — expected a positive integer`);
  }
  return parsed;
}

export type ServerRole = "canonical" | "legacy-readonly";

export function resolveServerRole(
  value: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ServerRole {
  if (value === "canonical" || value === "legacy-readonly") return value;
  // Tests preserve the historical writable default. Every real deployment
  // must opt in to canonical writes explicitly; missing/unknown values are
  // treated as a legacy export and therefore fail closed.
  if ((value === undefined || value === "") && nodeEnv === "test") {
    return "canonical";
  }
  return "legacy-readonly";
}

const PORT = requireInt(process.env.QOOPIA_PORT, "QOOPIA_PORT", 3737);
const SERVER_ROLE = resolveServerRole(process.env.QOOPIA_SERVER_ROLE);
const RUNTIME_PATHS = validateRuntimeConfiguration(process.env);

export const env = {
  PORT,
  SERVER_ROLE,
  ROOT_DIR: RUNTIME_PATHS.rootDir,
  INSTANCE_ID:
    process.env.QOOPIA_INSTANCE_ID ||
    `${SERVER_ROLE}:${os.hostname()}:${PORT}`,
  // Bind address. Default = loopback only. Production behind cloudflared/nginx
  // also stays on 127.0.0.1 (the proxy is local). Set QOOPIA_HOST=0.0.0.0 only
  // when you explicitly want LAN exposure — every auth surface (Bearer + OAuth)
  // assumes it can trust the network it listens on, so this is opt-in by design.
  HOST: process.env.QOOPIA_HOST || "127.0.0.1",
  DATA_DIR: RUNTIME_PATHS.dataDir,
  OPS_STATE_DIR: process.env.QOOPIA_OPS_STATE_DIR || RUNTIME_PATHS.dataDir,
  LOG_DIR: RUNTIME_PATHS.logDir,
  BACKUP_DIR: RUNTIME_PATHS.backupDir,
  LOG_LEVEL: (process.env.QOOPIA_LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  PUBLIC_URL: process.env.QOOPIA_PUBLIC_URL || `http://localhost:${requireInt(process.env.QOOPIA_PORT, "QOOPIA_PORT", 3737)}`,
  DASHBOARD_ALLOWED_ORIGINS: (process.env.QOOPIA_DASHBOARD_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  OAUTH_ISSUER: process.env.QOOPIA_OAUTH_ISSUER || "",
  ADMIN_SECRET: process.env.QOOPIA_ADMIN_SECRET || "",
  MAINTENANCE_HOUR: requireInt(process.env.QOOPIA_MAINTENANCE_HOUR, "QOOPIA_MAINTENANCE_HOUR", 4),
  BACKUP_KEEP: requireInt(process.env.QOOPIA_BACKUP_KEEP, "QOOPIA_BACKUP_KEEP", 7),
  RETENTION_ACTIVITY_DAYS: requireInt(process.env.QOOPIA_RETENTION_ACTIVITY_DAYS, "QOOPIA_RETENTION_ACTIVITY_DAYS", 90),
  RETENTION_AGENT_WAKE_DAYS: requirePositiveInt(
    process.env.QOOPIA_RETENTION_AGENT_WAKE_DAYS,
    "QOOPIA_RETENTION_AGENT_WAKE_DAYS",
    30,
  ),
  // Когда true, запросы от доверенных прокси могут нести клиентский IP в
  // cf-connecting-ip / x-forwarded-for. Default=false: небезопасные дефолты
  // не должны включаться сами. Поднимая Qoopia за cloudflared / nginx на
  // loopback — выставляй TRUST_PROXY=true в окружении (см. launchd plist).
  TRUST_PROXY: (process.env.TRUST_PROXY ?? "false") === "true",
  // Comma-separated список IP, которым доверяем хедеры. Запрос считается
  // пришедшим через доверенный прокси, только если socket.remoteAddress ∈ этому
  // списку. Default = loopback (нормальный случай за cloudflared/nginx).
  TRUSTED_PROXIES: (process.env.TRUSTED_PROXIES ?? "127.0.0.1,::1,::ffff:127.0.0.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

if (!env.OAUTH_ISSUER) env.OAUTH_ISSUER = env.PUBLIC_URL;
