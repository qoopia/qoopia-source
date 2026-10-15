import { db } from "../db/connection.ts";
import { env } from "../utils/env.ts";
import { backgroundFailure, logger } from "../utils/logger.ts";
import { recordMemoryAlert } from "../delivery/ops-state.ts";
import { deliverOpsAlerts, readOwnerAlertChannels } from "./ops-alerts.ts";
import { maintenanceInProgress } from "./retention.ts";

/** Subscription failures of the memory model that only the owner can fix. Before 5.0.21 they reached nobody:
 * a sign-in that expired on 10.10 was found four days later by an external script [A2-03, A5-07]. */
const CAUSES: Record<string, string> = { UNAUTHENTICATED: 'MEMORY_SIGN_IN_REQUIRED', MODEL_QUOTA: 'MEMORY_QUOTA',
  MODEL_UNAVAILABLE: 'MEMORY_MODEL_UNAVAILABLE', UNSUPPORTED: 'MEMORY_RUNTIME_UNSUPPORTED' };
/** A failure that comes back after a recovery within this time is not raised again: one signal, not a stream. */
export const MEMORY_ALERT_REPEAT_MS = 6 * 3600_000;
/** What the journal holds as far as this process knows; undefined until the first write after a start.
 * ponytail: one installation-wide state; per-workspace alerts if one installation serves several owners. */
let recorded: string | null | undefined;
const raisedAt = new Map<string, number>();
const failed = backgroundFailure('Memory model alert', 3600_000);

/** Called by the memory worker with the profile-wide failure code of an attempt, or null after a summary.
 * Writes the operations journal only on a change, and delivers through the owner's alert channels. */
export function memoryModelAlert(code: string | null, now = Date.now()) {
  const cause = code === null ? null : CAUSES[code];
  if (cause === undefined || cause === recorded) return;
  // The daily run's own process writes this journal now; the next attempt or summary records the change.
  if (maintenanceInProgress()) return;
  if (cause && now - (raisedAt.get(cause) ?? -Infinity) < MEMORY_ALERT_REPEAT_MS) return;
  try {
    const installation = (db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string} | null)?.instance_id ?? 'local';
    const raised = recordMemoryAlert(env.OPS_STATE_DIR, installation, cause, now);
    recorded = cause;
    if (!raised) return;
    raisedAt.set(cause!, now);
    logger.error("Memory model needs the owner", { cause });
    void deliverOpsAlerts(env.OPS_STATE_DIR, readOwnerAlertChannels(process.env.QOOPIA_OPS_CHANNELS_FILE)).catch(failed);
  } catch (error) { failed(error); }
}
