import {startMemoryMaintenance,stopMemoryMaintenance} from './services/continuity.ts';
import {
  getPendingMigrations,
} from "./db/migrate.ts";
import { closeDb, db } from "./db/connection.ts";
import { assertDatabaseIntegrity } from "./db/sqlite.ts";
import { startMaintenance, stopMaintenance } from "./services/retention.ts";
import {
  startAgentWakeWorker,
  stopAgentWakeWorker,
} from "./services/agent-wake.ts";
import { startHttpServer } from "./http.ts";
import { logger } from "./utils/logger.ts";
import { isReadOnlyInstance } from "./utils/instance-role.ts";

// QSA-D / Codex QSA-003 (2026-04-28): production startup must not silently
// apply pending migrations. Two reasons:
//   1) A bad migration mutates prod schema/data before any operator-approved
//      backup snapshot is taken. Recovery becomes painful.
//   2) An accidental restart during partial deployment may apply migrations
//      from a half-deployed code revision, leaving an inconsistent state.
//
// Behavior:
//   - On boot, list pending migrations.
//   - If none → proceed (no-op).
//   - If any are pending → fail closed. No environment flag can turn normal
//     service startup into a schema mutation path.
//
// `bun run migrate` is the only supported migration entry point. It performs
// a read-only integrity preflight and a 0600 VACUUM INTO backup before apply.
assertDatabaseIntegrity(db, "Startup database");
const pending = getPendingMigrations();
if (pending.length > 0) {
  if (isReadOnlyInstance()) {
    logger.error(
      `Refusing to start legacy-readonly export with ${pending.length} pending migration(s): ${pending.join(", ")}`,
    );
    logger.error("Apply migrations on the canonical instance through the approved release process first.");
    process.exit(1);
  }
  logger.error(
    `Refusing to start: ${pending.length} pending migration(s): ${pending.join(", ")}`,
  );
  logger.error(
    "Run `bun run db:integrity`, obtain the required backup/owner approval, " +
      "then run `bun run migrate` as a separate one-shot operation.",
  );
  process.exit(1);
}

if (!isReadOnlyInstance()) {
  startMaintenance();
  startMemoryMaintenance();
  startAgentWakeWorker();
}
const server = startHttpServer();

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  stopMaintenance();
  stopMemoryMaintenance();
  stopAgentWakeWorker();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Fallback in case close hangs
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
