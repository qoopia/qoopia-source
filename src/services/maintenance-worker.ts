/** The daily maintenance as its own process: runMaintenanceProcess (retention.ts) starts it and reads the
 * result over IPC; its logs go to the server's output. Standalone binary: src/delivery/entry.ts runs
 * runMaintenanceWorker() when QOOPIA_MAINTENANCE_WORKER is set. */
import { closeDb } from "../db/connection.ts";
import { runOperationalMaintenance } from "./retention.ts";

export async function runMaintenanceWorker() {
  try { process.send?.(await runOperationalMaintenance()); }
  finally { closeDb(); }
}
if (import.meta.main) await runMaintenanceWorker();
