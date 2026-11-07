/**
 * Session summaries (type='context': continuity checkpoints, handoffs, bootstrap
 * "WORKSPACE CONTEXT" notes) are long and mention almost everything an agent
 * touched, so both the FTS and the vector channel rank them high for any
 * topical query. On the 2026-11-04 recall eval they filled 42% of the default
 * top-10 and pushed the durable answer out of first place.
 *
 * An agent's own summaries are its continuity: on real agent queries in that
 * eval the right answer was a summary in 21 of 38 cases, 18 of them written by
 * the asking agent, while the summaries crowding the durable answers were
 * mostly other agents' (202 of 230). So by default only other agents'
 * summaries are demoted (contextDemotionScope()).
 *
 * Ordinary recall demotes them; nothing is removed:
 *  - their positional score 1/(k+i) is multiplied by contextDemotionFactor();
 *  - no more than contextTopCap() of them stay within the first
 *    contextCapWindow() positions, the rest follow right after that window.
 *
 * The old order is kept when the caller asks for context: an explicit `type`
 * filter, `scope='sessions'`, or a query about the session itself
 * ("CONTEXT", handoff, checkpoint, выжимка, на чём остановились …).
 */
import type { RecallParams } from "../recall.ts";
import { contextCapWindow, contextDemotionFactor, contextDemotionScope, contextTopCap, rrfK } from "./config.ts";

const CONTEXT_TYPE = "context";

// Whole words or stems: the query is about the session, a handoff or its history.
const SESSION_QUERY = new RegExp(
  [
    "\\bcontext\\b", "\\bhandoff", "\\bhand-off", "\\bcheckpoint", "\\bsession", "\\bsummary\\b", "\\brecap\\b",
    "\\bresume\\b", "\\bcontinuity\\b", "\\bwhere (?:did )?we (?:left|stop)", "\\blast time\\b", "\\bhistory\\b",
    "\\bwake\\b", "\\bpreviously\\b",
    "контекст", "сесси", "выжимк", "хэндофф", "хендофф", "передач[аиу] дел", "чекпоинт", "чек-поинт",
    "остановил", "продолж", "в прошлый раз", "прошл(?:ой|ую|ая) сесси", "истори", "что делали", "итоги? сесси",
  ].join("|"),
  "iu",
);

export function isSessionQuery(query: string): boolean {
  return SESSION_QUERY.test(query);
}

/** Whether ordinary-recall demotion applies to this call at all. */
export function contextDemotionApplies(p: Pick<RecallParams, "type" | "scope" | "query">): boolean {
  if (p.type) return false;
  if (p.scope === "sessions") return false;
  if (contextDemotionFactor() >= 1 && contextTopCap() < 0) return false;
  return !isSessionQuery(p.query);
}

/**
 * Stable reorder of an already ranked list. `isContext` tells which rows are
 * session summaries; only those move, and only downwards.
 */
export function demoteContext<T>(rows: T[], isContext: (row: T) => boolean): T[] {
  if (rows.length < 2) return rows;
  const factor = contextDemotionFactor();
  const k = rrfK();
  const ordered = factor >= 1
    ? rows.slice()
    : rows
        .map((row, index) => ({ row, index, score: (isContext(row) ? factor : 1) / (k + index + 1) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.row);
  return capContext(ordered, isContext);
}

/** At most contextTopCap() context rows inside the first contextCapWindow() positions. */
export function capContext<T>(rows: T[], isContext: (row: T) => boolean): T[] {
  const cap = contextTopCap();
  const window = contextCapWindow();
  if (cap < 0 || rows.length <= cap) return rows;
  const head: T[] = [];
  const deferred: T[] = [];
  let seen = 0;
  let index = 0;
  for (; index < rows.length && head.length < window; index++) {
    const row = rows[index]!;
    if (isContext(row) && ++seen > cap) deferred.push(row);
    else head.push(row);
  }
  return [...head, ...deferred, ...rows.slice(index)];
}

export function isContextNote(row: { type: string; source?: string }): boolean {
  return row.type === CONTEXT_TYPE && (row.source === undefined || row.source === "notes");
}

/** The summaries this caller's ordinary recall moves down. */
export function demotedContext(
  callerAgentId: string,
): (row: { type: string; source?: string; agent_id?: string | null }) => boolean {
  const all = contextDemotionScope() === "all";
  return (row) => isContextNote(row) && (all || row.agent_id !== callerAgentId);
}
