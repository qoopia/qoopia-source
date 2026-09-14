#!/usr/bin/env bun
/**
 * QSA-D / Codex QSA-003: explicit migrate runner.
 *
 * Use this when the prod startup gate refuses to boot because pending
 * migrations exist. Always takes a VACUUM INTO backup into BACKUP_DIR
 * before applying anything, then exits cleanly. Does NOT start the
 * HTTP server or maintenance loop — that is the job of `qoopia start`.
 *
 * Exit codes:
 *   0 — no pending migrations, or migrations applied successfully
 *   1 — migration failed; backup remains in place for restore
 */
import {
  backupDbBeforeMigrate,
  getPendingMigrations,
  runMigrations,
} from "../src/db/migrate.ts";
import { closeDb, db } from "../src/db/connection.ts";
import { assertDatabaseIntegrity } from "../src/db/sqlite.ts";
import { env } from "../src/utils/env.ts";
import { logger } from "../src/utils/logger.ts";

try {
  if (env.SERVER_ROLE !== "canonical") {
    throw new Error("Migrate refused: QOOPIA_SERVER_ROLE must be canonical");
  }
  const pending = getPendingMigrations();
  if (pending.length === 0) {
    logger.info("No pending migrations.");
    closeDb();
    process.exit(0);
  }
  logger.info(
    `Pending migrations (${pending.length}): ${pending.join(", ")}`,
  );
  assertDatabaseIntegrity(db, "pre-migration database");
  logger.info("Pre-migration integrity check passed");
  const backup = backupDbBeforeMigrate(pending);
  logger.info(`Pre-migrate backup: ${backup}`);
  runMigrations();
  logger.info(`Applied ${pending.length} migration(s) successfully.`);
  closeDb();
  process.exit(0);
} catch (err) {
  logger.error(`Migrate failed: ${err}`);
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
