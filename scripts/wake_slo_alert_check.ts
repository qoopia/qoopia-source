#!/usr/bin/env bun
/**
 * Wake SLO P2 alert check — Phase 2 Item H.
 *
 * Scans `wake_slo_probes` for a rolling 24h window and fires a P2 alert
 * when either:
 *   (a) N >= 30 attempts AND failure_rate > 0.05, OR
 *   (b) any single `unexplained_hang` row appears in the window.
 *
 * Alert sinks (both, independently):
 *   Sink A: Qoopia note via `createNote` (type='context', tags include
 *           'phase-1-item-1','wake-slo','alert','P2').
 *   Sink B: AgentComm message to corsair-main via `agentSend` with
 *           a unique topic.
 *
 * NO Telegram raw-alert sink (Q-P2-9). NO probe body bytes ever appear
 * in either sink — only metadata (counts, ids, error_class shares).
 *
 * Idempotency: mute state is persisted at
 *   $QOOPIA_ROOT/logs/wake_slo_alert_state.json
 * at the same path on host and container.
 * Within `mute_window_hours` of the last fire for the same reason class
 * AND direction, subsequent threshold breaches are no-ops.
 *
 * Exit codes:
 *   0 — clean (no alert fired, or muted)
 *   1 — alert fired this run
 *   2 — pre-check failure: not enough data yet (e.g., N<30 and no hangs)
 *
 * Usage:
 *   bun scripts/wake_slo_alert_check.ts [--mute-hours N] [--state-file PATH] [--window-hours N]
 *
 * The script DOES NOT install cron. Cron activation is a separate gate
 * (Item D acceptance + 7d post-responder-ship real data).
 */
import { db } from "../src/db/connection.ts";
import { agentSend } from "../src/services/agent-comm.ts";
import { createNote } from "../src/services/notes.ts";
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/utils/env.ts";

const WORKSPACE_ID = "01KMKRVYF2FN68D9N3C8BEGAHS";
const SELF_AGENT_NAME = "corsair-main";
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_THRESHOLD_RATE = 0.05;
const DEFAULT_THRESHOLD_N = 30;
const DEFAULT_MUTE_HOURS = 4;
const DEFAULT_STATE_FILE = path.join(env.LOG_DIR, "wake_slo_alert_state.json");

type Direction = "C2L" | "L2C";

interface ProbeRow {
  probe_id: number;
  direction: Direction;
  started_at: string;
  status: "ok" | "failed";
  error_class: string | null;
  session_id: string | null;
}

interface DirectionStats {
  direction: Direction;
  n: number;
  failed: number;
  failure_rate: number;
  unexplained_hangs: ProbeRow[];
  by_class: Record<string, number>;
}

/**
 * Mute is scoped per `(reason, direction)` tuple. Keyed map shape is
 * `{ "failure_rate_breach:C2L": "<iso>", "unexplained_hang:L2C": "<iso>", ... }`.
 *
 * R1 had a single `last_fire` object; that caused a different tuple's fire
 * to overwrite the previous tuple's mute-anchor and silently re-fire it on
 * the next run (Leo R1 BLOCK 01KSCX524947SY0V3JMFGD8GN6). Per-key map fixes
 * it. The single-tuple R1 schema is migrated on read by dropping it (safer
 * than guessing which tuple it was scoped to — the next breach simply gets
 * a fresh stamp under its own key).
 */
interface AlertState {
  last_fire_by_key?: Record<string, string>;
  /** Legacy R1 field — migrated on read by dropping. Kept here only so
   *  TypeScript does not silently accept arbitrary keys in JSON.parse. */
  last_fire?: unknown;
}

type AlertReason = "failure_rate_breach" | "unexplained_hang";

function muteKey(reason: AlertReason, direction: Direction): string {
  return `${reason}:${direction}`;
}

interface BreachSignal {
  direction: Direction;
  reason: AlertReason;
  stats: DirectionStats;
}

interface CliOpts {
  muteHours: number;
  stateFile: string;
  windowHours: number;
  thresholdRate: number;
  thresholdN: number;
  /** Test hook: override the workspace_id used for createNote + agentSend. */
  workspaceId?: string;
  /** Test hook: override the agent_id used as sender. */
  agentId?: string;
  /** Test hook: override the AgentComm recipient name. */
  selfAgentName?: string;
  /** Optional override for "now" (ISO ms) — test hook only. */
  nowIso?: string;
  /** Test hook: skip Sink A/B and return the breach instead. */
  dryRun?: boolean;
}

/* ────────────────────────────  pure helpers  ─────────────────────────── */

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    muteHours: DEFAULT_MUTE_HOURS,
    stateFile: DEFAULT_STATE_FILE,
    windowHours: DEFAULT_WINDOW_HOURS,
    thresholdRate: DEFAULT_THRESHOLD_RATE,
    thresholdN: DEFAULT_THRESHOLD_N,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mute-hours") opts.muteHours = Number(argv[++i]);
    else if (a === "--state-file") opts.stateFile = String(argv[++i]);
    else if (a === "--window-hours") opts.windowHours = Number(argv[++i]);
    else if (a === "--threshold-rate") opts.thresholdRate = Number(argv[++i]);
    else if (a === "--threshold-n") opts.thresholdN = Number(argv[++i]);
    else if (a === "--dry-run") opts.dryRun = true;
  }
  if (!Number.isFinite(opts.muteHours) || opts.muteHours <= 0) {
    throw new Error("--mute-hours must be a positive number");
  }
  if (!Number.isFinite(opts.windowHours) || opts.windowHours <= 0) {
    throw new Error("--window-hours must be a positive number");
  }
  return opts;
}

function isoNowMs(): string {
  return new Date().toISOString();
}

function windowStartIso(nowIso: string, windowHours: number): string {
  const ms = new Date(nowIso).getTime() - windowHours * 3_600_000;
  return new Date(ms).toISOString();
}

export function computeStats(rows: ProbeRow[], direction: Direction): DirectionStats {
  const subset = rows.filter((r) => r.direction === direction);
  const n = subset.length;
  const failed = subset.filter((r) => r.status !== "ok").length;
  const by_class: Record<string, number> = {};
  for (const r of subset) {
    const key = r.error_class || (r.status === "ok" ? "ok" : "unclassified");
    by_class[key] = (by_class[key] || 0) + 1;
  }
  const unexplained_hangs = subset.filter((r) => r.error_class === "unexplained_hang");
  return {
    direction,
    n,
    failed,
    failure_rate: n === 0 ? 0 : failed / n,
    unexplained_hangs,
    by_class,
  };
}

export function detectBreach(
  stats: DirectionStats,
  thresholdN: number,
  thresholdRate: number,
): BreachSignal | null {
  if (stats.unexplained_hangs.length > 0) {
    return { direction: stats.direction, reason: "unexplained_hang", stats };
  }
  if (stats.n >= thresholdN && stats.failure_rate > thresholdRate) {
    return { direction: stats.direction, reason: "failure_rate_breach", stats };
  }
  return null;
}

export function isMuted(
  state: AlertState,
  breach: BreachSignal,
  nowIso: string,
  muteHours: number,
): boolean {
  const key = muteKey(breach.reason, breach.direction);
  const lastIso = state.last_fire_by_key?.[key];
  if (!lastIso) return false;
  const ageMs = new Date(nowIso).getTime() - new Date(lastIso).getTime();
  return ageMs < muteHours * 3_600_000;
}

export function id8(s: string | null | undefined): string {
  if (!s) return "—";
  return s.length <= 8 ? s : s.slice(0, 8);
}

export function summariseSampleHangs(rows: ProbeRow[], max = 5): Array<{ probe_id: number; session_id8: string; started_at: string }> {
  return rows.slice(0, max).map((r) => ({
    probe_id: r.probe_id,
    session_id8: id8(r.session_id),
    started_at: r.started_at,
  }));
}

/* ────────────────────────────  state I/O  ────────────────────────────── */

export function readState(file: string): AlertState {
  try {
    const buf = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(buf);
    if (!parsed || typeof parsed !== "object") return {};
    // R1 → R2 migration: drop the legacy single-tuple `last_fire` field.
    // Dropping (rather than mapping) is safe because the next breach in
    // any tuple will write its own fresh stamp under the keyed map.
    const out: AlertState = {};
    if (parsed.last_fire_by_key && typeof parsed.last_fire_by_key === "object") {
      const valid: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.last_fire_by_key)) {
        if (typeof k === "string" && typeof v === "string") valid[k] = v;
      }
      out.last_fire_by_key = valid;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomically merge a single (reason, direction) → iso entry into the state
 * file without clobbering other tuples' mute anchors. Read-modify-write
 * with `tmp + rename`.
 */
/** Suppression ends when a condition resolves, even when no new notification is sent. */
export function clearResolvedAlerts(file: string, activeKeys: ReadonlySet<string>): AlertState {
  const current = readState(file), map = current.last_fire_by_key ?? {};
  const remaining = Object.fromEntries(Object.entries(map).filter(([key]) => activeKeys.has(key)));
  if (Object.keys(remaining).length !== Object.keys(map).length) writeState(file, {last_fire_by_key:remaining});
  return {last_fire_by_key:remaining};
}

export function recordFire(
  file: string,
  reason: AlertReason,
  direction: Direction,
  iso: string,
): AlertState {
  const current = readState(file);
  const map = { ...(current.last_fire_by_key || {}) };
  map[muteKey(reason, direction)] = iso;
  const next: AlertState = { last_fire_by_key: map };
  writeState(file, next);
  return next;
}

export function writeState(file: string, state: AlertState): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/* ────────────────────────────  DB I/O  ───────────────────────────────── */

function fetchWindowRows(sinceIso: string): ProbeRow[] {
  return db
    .prepare(
      `SELECT probe_id, direction, started_at, status, error_class, session_id
         FROM wake_slo_probes
        WHERE started_at >= ?
        ORDER BY started_at ASC`,
    )
    .all(sinceIso) as ProbeRow[];
}

function resolveAgentId(workspaceId: string, name: string): string {
  const row = db
    .prepare(`SELECT id FROM agents WHERE workspace_id = ? AND lower(name) = lower(?) AND active = 1 LIMIT 1`)
    .get(workspaceId, name) as { id: string } | undefined;
  if (!row) throw new Error(`agent not found: ${name}`);
  return row.id;
}

/* ────────────────────────────  alert sinks  ──────────────────────────── */

export interface AlertPayload {
  reason: AlertReason;
  direction: Direction;
  window_hours: number;
  window_start_iso: string;
  window_end_iso: string;
  n: number;
  failed: number;
  failure_rate: number;
  threshold_n: number;
  threshold_rate: number;
  by_class: Record<string, number>;
  sample_hangs: Array<{ probe_id: number; session_id8: string; started_at: string }>;
}

export function buildPayload(
  breach: BreachSignal,
  opts: { windowHours: number; thresholdN: number; thresholdRate: number; nowIso: string },
): AlertPayload {
  const sample_hangs = summariseSampleHangs(breach.stats.unexplained_hangs);
  return {
    reason: breach.reason,
    direction: breach.direction,
    window_hours: opts.windowHours,
    window_start_iso: windowStartIso(opts.nowIso, opts.windowHours),
    window_end_iso: opts.nowIso,
    n: breach.stats.n,
    failed: breach.stats.failed,
    failure_rate: Number(breach.stats.failure_rate.toFixed(4)),
    threshold_n: opts.thresholdN,
    threshold_rate: opts.thresholdRate,
    by_class: breach.stats.by_class,
    sample_hangs,
  };
}

function formatNoteText(payload: AlertPayload): string {
  const reason_word = payload.reason === "unexplained_hang"
    ? "UNEXPLAINED HANG"
    : "FAILURE RATE BREACH";
  const sampleLines = payload.sample_hangs.length === 0
    ? "_(none)_"
    : payload.sample_hangs
        .map((s) => `- probe_id=${s.probe_id} session=${s.session_id8} started_at=${s.started_at}`)
        .join("\n");
  const classLines = Object.entries(payload.by_class)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return [
    `# Wake SLO P2 alert — ${reason_word} (${payload.direction})`,
    "",
    "Source: `scripts/wake_slo_alert_check.ts` (Phase 2 Item H).",
    `Window: ${payload.window_start_iso} → ${payload.window_end_iso} (${payload.window_hours}h).`,
    "",
    "## Metrics",
    `- direction: ${payload.direction}`,
    `- n: ${payload.n} (threshold ≥ ${payload.threshold_n})`,
    `- failed: ${payload.failed}`,
    `- failure_rate: ${payload.failure_rate} (threshold > ${payload.threshold_rate})`,
    `- reason: ${payload.reason}`,
    "",
    "## Class breakdown",
    classLines || "_(empty window)_",
    "",
    "## Sample unexplained_hang rows (id8 only — NO body bytes)",
    sampleLines,
    "",
    "## Follow-up",
    "Read the full row via `SELECT * FROM wake_slo_probes WHERE probe_id IN (...)` on Corsair.",
    "Forensic message lookup: `SELECT id, kind, created_at FROM agent_comm_messages WHERE session_id = ?`.",
    `Mute window applied to next run: see \`${path.join(env.LOG_DIR, "wake_slo_alert_state.json")}\`.`,
  ].join("\n");
}

function formatAgentBody(payload: AlertPayload, noteId: string): string {
  return [
    `WAKE_SLO_P2_ALERT direction=${payload.direction} reason=${payload.reason}`,
    `window=${payload.window_hours}h n=${payload.n} failed=${payload.failed} rate=${payload.failure_rate}`,
    `thresholds n>=${payload.threshold_n} rate>${payload.threshold_rate}`,
    `hangs=${payload.sample_hangs.length}`,
    `note=${noteId}`,
  ].join(" ");
}

interface EmitOutcome {
  note_id: string;
  message_id: string;
  session_id: string;
}

export function emitAlert(
  payload: AlertPayload,
  workspaceId: string,
  agentId: string,
  selfAgentName: string,
  ts: number,
): EmitOutcome {
  const note = createNote({
    workspace_id: workspaceId,
    agent_id: agentId,
    text: formatNoteText(payload),
    type: "context",
    tags: ["phase-1-item-1", "wake-slo", "alert", "P2", `direction:${payload.direction}`, `reason:${payload.reason}`],
    metadata: {
      kind: "wake_slo_p2_alert",
      direction: payload.direction,
      reason: payload.reason,
      window_hours: payload.window_hours,
      n: payload.n,
      failed: payload.failed,
      failure_rate: payload.failure_rate,
      threshold_n: payload.threshold_n,
      threshold_rate: payload.threshold_rate,
      by_class: payload.by_class,
      sample_hangs: payload.sample_hangs,
    },
  });
  const sent = agentSend({
    workspace_id: workspaceId,
    agent_id: agentId,
    to_agent: selfAgentName,
    topic: `WAKE_SLO_P2_ALERT_${ts}`,
    body: formatAgentBody(payload, note.id),
    metadata: {
      self_alert: true,
      kind: "wake_slo_p2_alert",
      note_id: note.id,
      direction: payload.direction,
      reason: payload.reason,
    },
  });
  return { note_id: note.id, message_id: sent.id, session_id: sent.session_id };
}

/* ────────────────────────────  main flow  ────────────────────────────── */

export interface RunResult {
  exit_code: 0 | 1 | 2;
  reason: string;
  breach?: BreachSignal;
  payload?: AlertPayload;
  emit?: EmitOutcome;
  muted?: boolean;
  stats: DirectionStats[];
}

/**
 * Pure flow that takes the rows as input — used by tests to inject
 * synthetic probe distributions without touching the DB.
 */
export function evaluate(
  rows: ProbeRow[],
  opts: CliOpts & { nowIso: string },
): { breaches: BreachSignal[]; stats: DirectionStats[] } {
  const stats: DirectionStats[] = (["C2L", "L2C"] as Direction[]).map((d) => computeStats(rows, d));
  const breaches: BreachSignal[] = [];
  for (const s of stats) {
    const b = detectBreach(s, opts.thresholdN, opts.thresholdRate);
    if (b) breaches.push(b);
  }
  return { breaches, stats };
}

/**
 * Full alert run: DB → evaluate → mute check → emit. Returns a RunResult
 * that callers (CLI main, tests) can inspect.
 */
export function run(opts: CliOpts): RunResult {
  const nowIso = opts.nowIso || isoNowMs();
  const since = windowStartIso(nowIso, opts.windowHours);
  const rows = fetchWindowRows(since);
  const { breaches, stats } = evaluate(rows, { ...opts, nowIso });
  if (!opts.dryRun) clearResolvedAlerts(opts.stateFile, new Set(breaches.map(b => muteKey(b.reason,b.direction))));

  if (breaches.length === 0) {
    const totalN = stats.reduce((s, d) => s + d.n, 0);
    if (totalN < opts.thresholdN) {
      return { exit_code: 2, reason: `pre-check: only ${totalN} probes in window (need ≥${opts.thresholdN})`, stats };
    }
    return { exit_code: 0, reason: "clean", stats };
  }

  // Highest-severity breach first: unexplained_hang outranks failure_rate.
  breaches.sort((a, b) =>
    (b.reason === "unexplained_hang" ? 1 : 0) - (a.reason === "unexplained_hang" ? 1 : 0),
  );
  const primary = breaches[0];

  const state = readState(opts.stateFile);
  if (isMuted(state, primary, nowIso, opts.muteHours)) {
    return { exit_code: 0, reason: `muted (${opts.muteHours}h since last ${primary.reason}/${primary.direction})`, breach: primary, muted: true, stats };
  }

  const payload = buildPayload(primary, {
    windowHours: opts.windowHours,
    thresholdN: opts.thresholdN,
    thresholdRate: opts.thresholdRate,
    nowIso,
  });

  if (opts.dryRun) {
    return { exit_code: 1, reason: `dry-run breach: ${primary.reason}/${primary.direction}`, breach: primary, payload, stats };
  }

  const workspaceId = opts.workspaceId || WORKSPACE_ID;
  const selfAgentName = opts.selfAgentName || SELF_AGENT_NAME;
  const agentId = opts.agentId || resolveAgentId(workspaceId, selfAgentName);
  const ts = new Date(nowIso).getTime();
  const emit = emitAlert(payload, workspaceId, agentId, selfAgentName, ts);

  // Merge into the keyed map so this fire does not clobber another tuple's
  // mute anchor (R1 BLOCK fix — Leo verdict 01KSCX524947SY0V3JMFGD8GN6).
  recordFire(opts.stateFile, primary.reason, primary.direction, nowIso);

  return {
    exit_code: 1,
    reason: `alert fired: ${primary.reason}/${primary.direction} (note=${emit.note_id} msg=${emit.message_id})`,
    breach: primary,
    payload,
    emit,
    stats,
  };
}

function summariseForLog(result: RunResult): string {
  const stats = result.stats
    .map((s) => `${s.direction}:n=${s.n}/failed=${s.failed}/rate=${s.failure_rate.toFixed(4)}/hangs=${s.unexplained_hangs.length}`)
    .join(" ");
  return `[wake_slo_alert_check] exit=${result.exit_code} reason="${result.reason}" ${stats}`;
}

/* ────────────────────────────  entry point  ──────────────────────────── */

const invokedDirectly = import.meta.main;
if (invokedDirectly) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = run(opts);
    // One-line audit trail (parsable by future log shipping; no probe body bytes).
    console.log(summariseForLog(result));
    process.exit(result.exit_code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[wake_slo_alert_check] ERROR: ${msg}`);
    process.exit(2);
  }
}
