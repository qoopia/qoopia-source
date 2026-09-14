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
    schema_version: "ok" | "unavailable" | "uninitialized";
    pending_migrations: "ok" | "unavailable" | "pending";
    storage: "ok" | "degraded";
  };
}

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

export function evaluateReadiness(
  database: HealthDatabase,
  inspectPendingMigrations: () => readonly unknown[],
): ReadinessEvaluation {
  const schemaVersion = readSchemaVersion(database);
  const schemaCheck =
    schemaVersion === null
      ? "unavailable"
      : schemaVersion > 0
        ? "ok"
        : "uninitialized";

  let pendingMigrationsCheck: ReadinessEvaluation["checks"]["pending_migrations"];
  try {
    pendingMigrationsCheck =
      inspectPendingMigrations().length === 0 ? "ok" : "pending";
  } catch {
    pendingMigrationsCheck = "unavailable";
  }

  const storage = storageDegradation();
  return {
    ready: schemaCheck === "ok" && pendingMigrationsCheck === "ok" && !storage.degraded,
    schema_version: schemaVersion,
    checks: {
      schema_version: schemaCheck,
      pending_migrations: pendingMigrationsCheck,
      storage: storage.degraded ? "degraded" : "ok",
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
