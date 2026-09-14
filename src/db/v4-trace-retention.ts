import type { Database } from "bun:sqlite";

export interface TraceExpiryOptions {
  cutoff: string;
  batchSize?: number;
  /** Test-only fault hook used to prove detach/delete atomicity. */
  afterDetach?: () => void;
}

export interface TraceExpiryResult {
  selected: number;
  detached_feedback: number;
  deleted_items: number;
  deleted_traces: number;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Expire one bounded trace batch. Durable feedback is detached first; trace
 * items and headers are deleted only in the same BEGIN IMMEDIATE transaction.
 */
export function expireRecallTraceBatch(
  db: Database,
  options: TraceExpiryOptions,
): TraceExpiryResult {
  const batchSize = options.batchSize ?? 1_000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error(`Trace expiry batch size must be an integer in [1, 1000]`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const traces = db
      .query(
        `SELECT id, workspace_id
         FROM recall_traces
         WHERE expires_at <= ?
         ORDER BY expires_at ASC, id ASC
         LIMIT ?`,
      )
      .all(options.cutoff, batchSize) as Array<{
        id: string;
        workspace_id: string;
      }>;

    let detachedFeedback = 0;
    let deletedItems = 0;
    let deletedTraces = 0;
    const byWorkspace = new Map<string, string[]>();
    for (const trace of traces) {
      const ids = byWorkspace.get(trace.workspace_id) ?? [];
      ids.push(trace.id);
      byWorkspace.set(trace.workspace_id, ids);
    }

    for (const [workspaceId, ids] of byWorkspace) {
      const args = [workspaceId, ...ids];
      detachedFeedback += db
        .query(
          `UPDATE recall_feedback
           SET trace_id = NULL
           WHERE workspace_id = ? AND trace_id IN (${placeholders(ids.length)})`,
        )
        .run(...args).changes;
    }

    options.afterDetach?.();

    for (const [workspaceId, ids] of byWorkspace) {
      const args = [workspaceId, ...ids];
      deletedItems += db
        .query(
          `DELETE FROM recall_trace_items
           WHERE workspace_id = ? AND trace_id IN (${placeholders(ids.length)})`,
        )
        .run(...args).changes;
      deletedTraces += db
        .query(
          `DELETE FROM recall_traces
           WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})`,
        )
        .run(...args).changes;
    }

    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Trace expiry foreign_key_check failed with ${violations.length} violation(s)`,
      );
    }
    db.exec("COMMIT");
    return {
      selected: traces.length,
      detached_feedback: detachedFeedback,
      deleted_items: deletedItems,
      deleted_traces: deletedTraces,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original failure if SQLite already rolled back.
    }
    throw error;
  }
}
