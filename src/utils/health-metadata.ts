import { storageDegradation } from "./storage-degradation.ts";

interface HealthDatabase {
  prepare(sql: string): {
    get(): unknown;
  };
}

export interface ReadinessEvaluation {
  ready: boolean;
  schema_version: number | null;
  checks: {
    schema_version: "ok" | "unavailable" | "uninitialized" | "ahead";
    pending_migrations: "ok" | "unavailable" | "pending";
    storage: "ok" | "degraded" | "low_space";
    /** Writable instances only. */
    db_write?: DbWriteCheck;
  };
}

export type DbWriteCheck = "ok" | "busy" | "readonly" | "error";

export function readSchemaVersion(database: HealthDatabase): number | null {
  try {
    const row = database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_versions")
      .get() as { version?: unknown } | undefined;
    return typeof row?.version === "number" && Number.isInteger(row.version)
      ? row.version
      : null;
  } catch {
    return null;
  }
}

export interface ReadinessProbes {
  /** Newest migration this build ships; a database above it was written by newer software. */
  latestShippedMigration?: () => number;
  /** Can this process take the write lock now? See createWriteProbe. */
  probeWrite?: () => DbWriteCheck;
  /** Free bytes on the data volume; below minFreeBytes the instance is not ready. */
  freeBytes?: () => number;
  minFreeBytes?: number;
}

/** A write needs the lock and a writable file: take the lock briefly (BEGIN IMMEDIATE plus a no-op
 * header write, rolled back) at most every 10 s, since /ready is unauthenticated. A full disk is not
 * visible this way, because the change stays in the page cache; freeBytes covers that. A foreign
 * writer must hold the lock across two probes before it counts, so a backup step or an operator's
 * sqlite3 does not make readiness flap. */
export function createWriteProbe(
  database: { exec(sql: string): unknown; prepare(sql: string): { get(): unknown }; readonly inTransaction: boolean },
  busyTimeoutMs: number,
  now: () => number = Date.now,
): () => DbWriteCheck {
  let last: { at: number; result: DbWriteCheck } | undefined;
  let busyBefore = false;
  return () => {
    if (last && now() - last.at < 10_000) return last.result;
    let result: DbWriteCheck = "ok";
    let began = false;
    try {
      database.exec("PRAGMA busy_timeout = 200");
      database.exec("BEGIN IMMEDIATE");
      began = true;
      const { user_version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
      database.exec(`PRAGMA user_version = ${Number(user_version)}`);
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? "");
      result = code.startsWith("SQLITE_BUSY") ? "busy" : code.startsWith("SQLITE_READONLY") ? "readonly" : "error";
    } finally {
      if (began && database.inTransaction) database.exec("ROLLBACK");
      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    }
    if (result === "busy" && !busyBefore) {
      busyBefore = true;
      result = "ok";
    } else if (result !== "busy") busyBefore = false;
    last = { at: now(), result };
    return result;
  };
}

export function evaluateReadiness(
  database: HealthDatabase,
  inspectPendingMigrations: () => readonly unknown[],
  probes: ReadinessProbes = {},
): ReadinessEvaluation {
  const schemaVersion = readSchemaVersion(database);
  let schemaCheck: ReadinessEvaluation["checks"]["schema_version"] =
    schemaVersion === null
      ? "unavailable"
      : schemaVersion > 0
        ? "ok"
        : "uninitialized";
  try {
    if (schemaVersion !== null && probes.latestShippedMigration && schemaVersion > probes.latestShippedMigration()) schemaCheck = "ahead";
  } catch {
    schemaCheck = "unavailable";
  }

  let pendingMigrationsCheck: ReadinessEvaluation["checks"]["pending_migrations"];
  try {
    pendingMigrationsCheck =
      inspectPendingMigrations().length === 0 ? "ok" : "pending";
  } catch {
    pendingMigrationsCheck = "unavailable";
  }

  const storage = storageDegradation();
  let lowSpace = false;
  try {
    lowSpace = probes.freeBytes !== undefined && probes.freeBytes() < (probes.minFreeBytes ?? 0);
  } catch {
    // An unreadable volume shows up in the write probe; statfs alone is not evidence.
  }
  const dbWrite = probes.probeWrite?.();
  return {
    ready: schemaCheck === "ok" && pendingMigrationsCheck === "ok" && !storage.degraded && !lowSpace && (dbWrite ?? "ok") === "ok",
    schema_version: schemaVersion,
    checks: {
      schema_version: schemaCheck,
      pending_migrations: pendingMigrationsCheck,
      storage: storage.degraded ? "degraded" : lowSpace ? "low_space" : "ok",
      ...(dbWrite ? { db_write: dbWrite } : {}),
    },
  };
}

export function getV4FeatureFlags(environment: NodeJS.ProcessEnv = process.env) {
  return {
    relations: environment.QOOPIA_V4_RELATIONS === "true",
    latest_only: environment.QOOPIA_V4_LATEST_ONLY === "true",
    recall_explain: environment.QOOPIA_V4_RECALL_EXPLAIN === "true",
    lifecycle: environment.QOOPIA_V4_LIFECYCLE === "true",
    extraction: environment.QOOPIA_V4_EXTRACTION === "true",
    feedback: environment.QOOPIA_V4_FEEDBACK === "true",
    event_outbox: environment.QOOPIA_V4_EVENT_OUTBOX === "true",
    dashboard: environment.QOOPIA_V4_DASHBOARD === "true",
    // V4.1 bi-temporal. Mirrors bitemporalEnabled() in utils/temporal.ts, which
    // accepts "1" as well as "true" — /ready must report the value the code acts on.
    bitemporal:
      environment.QOOPIA_V4_BITEMPORAL === "true" || environment.QOOPIA_V4_BITEMPORAL === "1",
  };
}
