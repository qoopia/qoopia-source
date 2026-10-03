import { appendManagedLog } from "./managed-logs.ts";
import { hash } from "./fs.ts";
import { env } from "./env.ts";
import { redactSecretSpans } from "./secret-guard.ts";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const threshold = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|body|content|query|note[_-]?text)/i;

export function redactLogContext(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    const masked = redactSecretSpans(value);
    return masked.length > 1_024 ? `${masked.slice(0, 1_024)}...[TRUNCATED]` : masked;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactLogContext(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([childKey, child]) => [childKey, redactLogContext(child, childKey, depth + 1)]),
    );
  }
  return value;
}

export function sanitizeLogMessage(message: string): string {
  // Mask secret spans (not the whole line) before bounding: a cut could shorten
  // a token below its detector floor and leak the fragment.
  const masked = redactSecretSpans(message);
  const bounded = masked.length > 2_048 ? `${masked.slice(0, 2_048)}...[TRUNCATED]` : masked;
  return bounded
    .replace(/((?:authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|body|content|query|note[_-]?text)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/([?&][A-Za-z0-9_.~-]{1,100}=)[^&\s]*/g, "$1[REDACTED]")
    // One call, one line: escape CR/LF, NEL, LS/PS, ESC and other controls so
    // request data interpolated into a message cannot forge log lines.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function fmt(level: string, msg: string, ctx?: unknown): string {
  const stamp = new Date().toISOString();
  const ctxStr = ctx ? " " + JSON.stringify(redactLogContext(ctx)) : "";
  return `${stamp} ${level.toUpperCase()} ${sanitizeLogMessage(msg)}${ctxStr}`;
}

function persist(level: string, msg: string) {
  if (process.env.QOOPIA_STANDALONE === "true" && process.env.QOOPIA_MANAGED_LOGS === "true") {
    try { appendManagedLog(env.LOG_DIR, level, hash(sanitizeLogMessage(msg))); }
    catch { console.error("Managed application log unavailable; run doctor"); }
  }
}

export const logger = {
  debug(msg: string, ctx?: unknown) {
    persist("debug", msg);
    if (threshold <= LEVELS.debug) console.log(fmt("debug", msg, ctx));
  },
  info(msg: string, ctx?: unknown) {
    persist("info", msg);
    if (threshold <= LEVELS.info) console.log(fmt("info", msg, ctx));
  },
  warn(msg: string, ctx?: unknown) {
    persist("warn", msg);
    if (threshold <= LEVELS.warn) console.warn(fmt("warn", msg, ctx));
  },
  error(msg: string, ctx?: unknown) {
    persist("error", msg);
    if (threshold <= LEVELS.error) console.error(fmt("error", msg, ctx));
  },
};

// A background loop fails on every tick while its cause lasts: one warn per
// task per minute keeps it visible without flooding the log. Only the error
// message is logged, never the data the task was handling.
export function backgroundFailure(task: string, everyMs = 60_000) {
  let lastAt = -Infinity;
  return (error: unknown) => {
    if (Date.now() - lastAt < everyMs) return;
    lastAt = Date.now();
    logger.warn(`${task} failed`, { error: error instanceof Error ? error.message : String(error) });
  };
}
