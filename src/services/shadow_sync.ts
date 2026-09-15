/**
 * Shadow sync engine — Mac mini ⇄ Corsair Qoopia.
 *
 * Phase 2 Item B (plan note 01KSC0E9F1WFWJMSP58KS34H2A).
 * Design doc: $QOOPIA_ROOT/docs/shadow-sync-design.md.
 *
 * Hard rules:
 *   1. Dry-run is STRICTLY read-only against both target DBs. The engine
 *      opens DBs with { readonly: true } in dry-run mode and never holds a
 *      writable handle to either side. The only side-effect of a dry-run is
 *      the operator-visible report file under /logs/.
 *   2. sync_applied_hashes is written ONLY by the --apply path, after each
 *      row mutation succeeds.
 *   3. --apply requires a short-lived HMAC-signed authorization manifest
 *      bound to the exact plan, source/target paths, review id, and owner
 *      approval id. SHADOW_SYNC_APPLY_AUTHORIZED is the signing secret.
 *
 * Tables:
 *   - notes      → LWW by updated_at_ms (text fallback), tie-break via SOT_RULES
 *   - activity   → append-only union; same-ID content divergence is a conflict
 *
 * Everything else excluded per design doc §"Per-table SoT rules".
 */
import { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync, existsSync, realpathSync, statSync } from "node:fs";
import {
  assertDatabaseIntegrity,
  configureWritableDatabase,
  openReadonlyDatabase,
  openWritableDatabase,
  SQLITE_BUSY_TIMEOUT_MS,
} from "../db/sqlite.ts";

// Q1 decision — per-type tie-break (plan note Item A, Leo R1 OK on Q-P2-1).
export const SOT_RULES: Record<string, "M" | "C"> = {
  memory: "M",
  contact: "M",
  project: "M",
  deal: "M",
  note: "C",
  task: "C",
  finance: "C",
  knowledge: "C",
  rule: "C",
  context: "C",
  decision: "C",
};

// Synced tables: notes, activity. Every other table is excluded by design
// (see §"Per-table SoT"): embeddings, agent_comm_*, agent_wake_events,
// sessions, session_messages, wake_slo_probes, recall_log, agents,
// workspaces, oauth_clients, oauth_tokens, summaries, idempotency_keys,
// consent_tickets, claude_code_agents, users, schema_versions.

/**
 * Canonical JSON serializer (RFC 8785 JCS-style, simplified): sorts object
 * keys recursively, no insignificant whitespace, JSON.stringify on primitives.
 * Used inside rowHash so equal-content rows always produce equal hashes
 * across hosts regardless of how the DB serializer ordered keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as object).sort();
  return (
    "{" +
    keys
      .map(
        (k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

/**
 * Re-canonicalise a JSON-string field. Tolerates malformed JSON (returns the
 * raw string unchanged) so the hash stays deterministic for legacy rows that
 * may have non-JSON metadata fragments.
 */
function canonicaliseJsonField(raw: string | null): string {
  if (raw === null || raw === undefined) return "null";
  try {
    return canonicalJson(JSON.parse(raw));
  } catch {
    return JSON.stringify(raw);
  }
}

/**
 * Per-row hash:
 *   H = sha256(table || \n || id || \n || updated_at_ms || \n
 *              || k1=canonicalJson(v1) || \n || k2=canonicalJson(v2) ... )
 * The fieldSet keys are sorted before hashing so the order of insertion into
 * the map is irrelevant.
 */
export function rowHash(
  table: string,
  rowId: string,
  updatedAtMs: number,
  fieldSet: Record<string, unknown>,
): string {
  const h = createHash("sha256");
  h.update(table);
  h.update("\n");
  h.update(rowId);
  h.update("\n");
  h.update(String(updatedAtMs));
  h.update("\n");
  for (const k of Object.keys(fieldSet).sort()) {
    h.update(k);
    h.update("=");
    h.update(canonicalJson(fieldSet[k]));
    h.update("\n");
  }
  return h.digest("hex");
}

export interface NoteRow {
  id: string;
  type: string;
  text: string;
  metadata: string;
  project_id: string | null;
  task_bound_id: string | null;
  session_id: string | null;
  source: string;
  tags: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  updated_at_ms?: number;
  visibility: string;
}

export interface ActivityRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  summary: string;
  details: string;
  created_at: string;
  visibility: string;
  origin_host?: string;
}

export interface Candidate {
  table: string;
  rowId: string;
  direction: "M2C" | "C2M" | "conflict" | "noop";
  winner: "M" | "C" | null;
  localUpdatedAtMs: number;
  remoteUpdatedAtMs: number;
  diffSummary: string;
  conflictReason?: string;
  localHash: string;
  remoteHash: string;
  type?: string;
}

// Parse ISO-8601 UTC timestamp → ms since epoch. Returns 0 on parse failure;
// the engine treats 0 as "unknown, fall through to other side". Mac mini stores
// seconds-precision ISO strings; Corsair (post-migration 017) keeps a
// dedicated updated_at_ms column, but pre-017 rows + Mac mini rows hit this path.
export function parseIsoToMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function effectiveUpdatedAtMs(row: NoteRow): number {
  if (row.updated_at_ms && row.updated_at_ms > 0) return row.updated_at_ms;
  return parseIsoToMs(row.updated_at);
}

function notesFieldSet(row: NoteRow): Record<string, unknown> {
  return {
    type: row.type,
    text: row.text,
    metadata: canonicaliseJsonField(row.metadata),
    project_id: row.project_id,
    task_bound_id: row.task_bound_id,
    session_id: row.session_id,
    source: row.source,
    tags: canonicaliseJsonField(row.tags),
    visibility: row.visibility,
    deleted_at: row.deleted_at,
  };
}

function notesHash(row: NoteRow): string {
  return rowHash("notes", row.id, effectiveUpdatedAtMs(row), notesFieldSet(row));
}

function activityFieldSet(row: ActivityRow): Record<string, unknown> {
  return {
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    project_id: row.project_id,
    summary: row.summary,
    details: canonicaliseJsonField(row.details),
    visibility: row.visibility,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
  };
}

function activityHash(row: ActivityRow): string {
  // origin_host deliberately EXCLUDED from the hash — it is the receiver's
  // perspective on which side the row came from, not part of row content.
  return rowHash(
    "activity",
    row.id,
    parseIsoToMs(row.created_at),
    activityFieldSet(row),
  );
}

function activityDiffSummary(local: ActivityRow, remote: ActivityRow): string {
  const parts: string[] = ["same-id activity content divergence"];
  if (local.action !== remote.action) parts.push("action differs");
  if (local.entity_type !== remote.entity_type) parts.push("entity_type differs");
  if (local.entity_id !== remote.entity_id) parts.push("entity_id differs");
  if (local.project_id !== remote.project_id) parts.push("project_id differs");
  if (local.agent_id !== remote.agent_id) parts.push("agent_id differs");
  if (local.workspace_id !== remote.workspace_id) parts.push("workspace_id differs");
  if (local.summary.length !== remote.summary.length) {
    parts.push(`summary len ${local.summary.length}→${remote.summary.length}`);
  }
  if (local.details.length !== remote.details.length) {
    parts.push(`details len ${local.details.length}→${remote.details.length}`);
  }
  if (local.visibility !== remote.visibility) parts.push("visibility differs");
  if (local.created_at !== remote.created_at) parts.push("created_at differs");
  return parts.join(", ");
}

/**
 * Length/count-only diff summary for a notes row. NEVER returns body bytes
 * (rubric §7). Keys present in metadata are listed by NAME only when neither
 * side's value matches the secret-pattern blocklist below.
 */
const SECRET_KEY_RE = /(secret|token|key|password|cookie|authorization|bearer)/i;
function notesDiffSummary(local: NoteRow, remote: NoteRow): string {
  if (!remote) return "new row (insert)";
  if (!local) return "new row (insert)";
  const parts: string[] = [];
  if (local.text.length !== remote.text.length) {
    parts.push(`text len ${local.text.length}→${remote.text.length}`);
  }
  // Tag count delta
  const lt = safeArrayLen(local.tags);
  const rt = safeArrayLen(remote.tags);
  if (lt !== rt) parts.push(`tags ${lt}→${rt}`);
  // Metadata key delta — names only, and only if not secret-suggestive
  const lk = safeObjectKeys(local.metadata);
  const rk = safeObjectKeys(remote.metadata);
  const added = rk.filter((k) => !lk.includes(k) && !SECRET_KEY_RE.test(k));
  const removed = lk.filter((k) => !rk.includes(k) && !SECRET_KEY_RE.test(k));
  if (added.length) parts.push(`+meta:${added.join(",")}`);
  if (removed.length) parts.push(`-meta:${removed.join(",")}`);
  if (local.type !== remote.type) parts.push(`type ${local.type}→${remote.type}`);
  if (local.deleted_at !== remote.deleted_at) {
    parts.push(
      `deleted_at ${local.deleted_at ? "set" : "null"}→${remote.deleted_at ? "set" : "null"}`,
    );
  }
  return parts.length ? parts.join(", ") : "unchanged-except-timestamp";
}

function safeArrayLen(s: string | null): number {
  if (!s) return 0;
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) ? j.length : 0;
  } catch {
    return 0;
  }
}

function safeObjectKeys(s: string | null): string[] {
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j) : [];
  } catch {
    return [];
  }
}

/**
 * Detect whether a DB has the updated_at_ms column (post-017) or not
 * (pre-017, e.g. Mac mini at v13 or Corsair before deploy).
 */
function hasUpdatedAtMs(db: Database): boolean {
  const cols = db
    .query("PRAGMA table_info(notes)")
    .all() as Array<{ name: string }>;
  return cols.some((c) => c.name === "updated_at_ms");
}

function hasOriginHost(db: Database): boolean {
  const cols = db
    .query("PRAGMA table_info(activity)")
    .all() as Array<{ name: string }>;
  return cols.some((c) => c.name === "origin_host");
}

function readNotes(db: Database): NoteRow[] {
  const cols = [
    "id",
    "type",
    "text",
    "metadata",
    "project_id",
    "task_bound_id",
    "session_id",
    "source",
    "tags",
    "deleted_at",
    "created_at",
    "updated_at",
    "visibility",
  ];
  if (hasUpdatedAtMs(db)) cols.push("updated_at_ms");
  const sql = `SELECT ${cols.join(", ")} FROM notes ORDER BY id`;
  return db.query(sql).all() as NoteRow[];
}

function readActivity(db: Database): ActivityRow[] {
  const cols = [
    "id",
    "workspace_id",
    "agent_id",
    "action",
    "entity_type",
    "entity_id",
    "project_id",
    "summary",
    "details",
    "created_at",
    "visibility",
  ];
  if (hasOriginHost(db)) cols.push("origin_host");
  const sql = `SELECT ${cols.join(", ")} FROM activity ORDER BY id`;
  return db.query(sql).all() as ActivityRow[];
}

/**
 * Build the candidate set for `notes`. Pure function — no DB writes.
 * Sides labelled M (Mac mini) and C (Corsair) by argument position.
 */
export function planNotesSync(macRows: NoteRow[], corRows: NoteRow[]): Candidate[] {
  const macById = new Map<string, NoteRow>();
  for (const r of macRows) macById.set(r.id, r);
  const corById = new Map<string, NoteRow>();
  for (const r of corRows) corById.set(r.id, r);

  const allIds = new Set<string>([...macById.keys(), ...corById.keys()]);
  const out: Candidate[] = [];
  for (const id of allIds) {
    const m = macById.get(id);
    const c = corById.get(id);
    if (m && !c) {
      out.push({
        table: "notes",
        rowId: id,
        direction: "M2C",
        winner: "M",
        localUpdatedAtMs: effectiveUpdatedAtMs(m),
        remoteUpdatedAtMs: 0,
        diffSummary: "new row (insert)",
        localHash: notesHash(m),
        remoteHash: "",
        type: m.type,
      });
      continue;
    }
    if (c && !m) {
      out.push({
        table: "notes",
        rowId: id,
        direction: "C2M",
        winner: "C",
        localUpdatedAtMs: 0,
        remoteUpdatedAtMs: effectiveUpdatedAtMs(c),
        diffSummary: "new row (insert)",
        localHash: "",
        remoteHash: notesHash(c),
        type: c.type,
      });
      continue;
    }
    // Both sides present.
    const lh = notesHash(m!);
    const rh = notesHash(c!);
    if (lh === rh) {
      out.push({
        table: "notes",
        rowId: id,
        direction: "noop",
        winner: null,
        localUpdatedAtMs: effectiveUpdatedAtMs(m!),
        remoteUpdatedAtMs: effectiveUpdatedAtMs(c!),
        diffSummary: "identical content",
        localHash: lh,
        remoteHash: rh,
        type: m!.type,
      });
      continue;
    }
    const lms = effectiveUpdatedAtMs(m!);
    const rms = effectiveUpdatedAtMs(c!);
    if (lms > rms) {
      out.push({
        table: "notes",
        rowId: id,
        direction: "M2C",
        winner: "M",
        localUpdatedAtMs: lms,
        remoteUpdatedAtMs: rms,
        diffSummary: notesDiffSummary(c!, m!),
        localHash: lh,
        remoteHash: rh,
        type: m!.type,
      });
    } else if (rms > lms) {
      out.push({
        table: "notes",
        rowId: id,
        direction: "C2M",
        winner: "C",
        localUpdatedAtMs: lms,
        remoteUpdatedAtMs: rms,
        diffSummary: notesDiffSummary(m!, c!),
        localHash: lh,
        remoteHash: rh,
        type: c!.type,
      });
    } else {
      // Timestamps equal but content differs → tie-break by type, else conflict.
      const t = m!.type;
      const rule = SOT_RULES[t];
      if (rule === "M") {
        out.push({
          table: "notes",
          rowId: id,
          direction: "M2C",
          winner: "M",
          localUpdatedAtMs: lms,
          remoteUpdatedAtMs: rms,
          diffSummary: `tie-break SOT=M ${notesDiffSummary(c!, m!)}`,
          localHash: lh,
          remoteHash: rh,
          type: t,
        });
      } else if (rule === "C") {
        out.push({
          table: "notes",
          rowId: id,
          direction: "C2M",
          winner: "C",
          localUpdatedAtMs: lms,
          remoteUpdatedAtMs: rms,
          diffSummary: `tie-break SOT=C ${notesDiffSummary(m!, c!)}`,
          localHash: lh,
          remoteHash: rh,
          type: t,
        });
      } else {
        out.push({
          table: "notes",
          rowId: id,
          direction: "conflict",
          winner: null,
          localUpdatedAtMs: lms,
          remoteUpdatedAtMs: rms,
          diffSummary: notesDiffSummary(m!, c!),
          conflictReason: "tie_break_unknown_type",
          localHash: lh,
          remoteHash: rh,
          type: t,
        });
      }
    }
  }
  // Deterministic order: by (rowId).
  out.sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
  return out;
}

/**
 * Build the candidate set for `activity`. Append-only union — rows only on one
 * side become inserts. Same-ID rows are hash-compared: equal content is a
 * no-op, while divergent content is an explicit conflict rather than being
 * silently discarded. origin_host is receiver metadata and is not hashed.
 */
export function planActivitySync(
  macRows: ActivityRow[],
  corRows: ActivityRow[],
): Candidate[] {
  const macById = new Map(macRows.map((row) => [row.id, row]));
  const corById = new Map(corRows.map((row) => [row.id, row]));
  const allIds = new Set([...macById.keys(), ...corById.keys()]);
  const out: Candidate[] = [];
  for (const id of allIds) {
    const m = macById.get(id);
    const c = corById.get(id);
    if (m && !c) {
      out.push({
        table: "activity",
        rowId: m.id,
        direction: "M2C",
        winner: "M",
        localUpdatedAtMs: parseIsoToMs(m.created_at),
        remoteUpdatedAtMs: 0,
        diffSummary: "append-only union",
        localHash: activityHash(m),
        remoteHash: "",
        type: m.action,
      });
      continue;
    }
    if (c && !m) {
      out.push({
        table: "activity",
        rowId: c.id,
        direction: "C2M",
        winner: "C",
        localUpdatedAtMs: 0,
        remoteUpdatedAtMs: parseIsoToMs(c.created_at),
        diffSummary: "append-only union",
        localHash: "",
        remoteHash: activityHash(c),
        type: c.action,
      });
      continue;
    }
    const localHash = activityHash(m!);
    const remoteHash = activityHash(c!);
    out.push({
      table: "activity",
      rowId: id,
      direction: localHash === remoteHash ? "noop" : "conflict",
      winner: null,
      localUpdatedAtMs: parseIsoToMs(m!.created_at),
      remoteUpdatedAtMs: parseIsoToMs(c!.created_at),
      diffSummary:
        localHash === remoteHash
          ? "identical content"
          : activityDiffSummary(m!, c!),
      ...(localHash === remoteHash
        ? {}
        : { conflictReason: "same_id_activity_divergence" }),
      localHash,
      remoteHash,
      type: m!.action,
    });
  }
  out.sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
  return out;
}

export interface SyncPlan {
  notes: Candidate[];
  activity: Candidate[];
  generatedAt: string;
  macSnapshotPath: string;
  corSnapshotPath: string;
}

export function buildPlan(macDbPath: string, corDbPath: string): SyncPlan {
  if (!existsSync(macDbPath)) {
    throw new Error(`mac DB not found: ${macDbPath}`);
  }
  if (!existsSync(corDbPath)) {
    throw new Error(`cor DB not found: ${corDbPath}`);
  }
  const mac = openReadonlyDatabase(macDbPath);
  const cor = openReadonlyDatabase(corDbPath);
  try {
    const macNotes = readNotes(mac);
    const corNotes = readNotes(cor);
    const macActivity = readActivity(mac);
    const corActivity = readActivity(cor);
    return {
      notes: planNotesSync(macNotes, corNotes),
      activity: planActivitySync(macActivity, corActivity),
      generatedAt: new Date().toISOString(),
      macSnapshotPath: macDbPath,
      corSnapshotPath: corDbPath,
    };
  } finally {
    mac.close();
    cor.close();
  }
}

/** Render the markdown report. Deterministic — same plan → same bytes. */
export function renderReport(plan: SyncPlan, tsLabel: string): string {
  const lines: string[] = [];
  lines.push(`# Shadow sync dry-run — ${tsLabel}`);
  lines.push(`- Hosts: Mac mini (M) ⇄ Corsair (C)`);
  lines.push(`- Pre-sync snapshots: M=${plan.macSnapshotPath}, C=${plan.corSnapshotPath}`);
  lines.push(`- LCA strategy: first-sync-bootstrap (no prior sync_applied_hashes)`);
  lines.push("");

  // ## Table: notes
  lines.push("## Table: notes");
  lines.push(
    "| direction | id8       | type      | updated_at_local_ms | updated_at_remote_ms | winner | diff_summary |",
  );
  lines.push(
    "| --------- | --------- | --------- | ------------------- | -------------------- | ------ | ------------ |",
  );
  const notesRendered = plan.notes.filter((c) => c.direction !== "noop");
  const cap = 500;
  let truncated = false;
  for (const c of notesRendered.slice(0, cap)) {
    if (c.direction === "conflict") continue; // conflicts go in their own section
    lines.push(
      `| ${c.direction.padEnd(9)} | ${c.rowId.slice(0, 8)} | ${(c.type ?? "").padEnd(9)} | ${String(c.localUpdatedAtMs).padEnd(19)} | ${String(c.remoteUpdatedAtMs).padEnd(20)} | ${c.winner ?? "—"}      | ${c.diffSummary} |`,
    );
  }
  if (notesRendered.length > cap) truncated = true;
  lines.push("");

  // ## Table: activity
  lines.push("## Table: activity");
  lines.push(
    "| direction | id8       | action          | created_at_ms        | winner | diff_summary |",
  );
  lines.push(
    "| --------- | --------- | --------------- | -------------------- | ------ | ------------ |",
  );
  const actRendered = plan.activity.filter((c) => c.direction !== "noop");
  for (const c of actRendered.slice(0, cap)) {
    if (c.direction === "conflict") continue;
    const ms = c.winner === "M" ? c.localUpdatedAtMs : c.remoteUpdatedAtMs;
    lines.push(
      `| ${c.direction.padEnd(9)} | ${c.rowId.slice(0, 8)} | ${(c.type ?? "").padEnd(15)} | ${String(ms).padEnd(20)} | ${c.winner ?? "—"}      | ${c.diffSummary} |`,
    );
  }
  if (actRendered.length > cap) truncated = true;
  lines.push("");

  // ## Conflicts
  const conflicts = [...plan.notes, ...plan.activity].filter(
    (c) => c.direction === "conflict",
  );
  lines.push("## Conflicts");
  if (conflicts.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| table    | id8       | type      | reason                      | diff_summary |");
    lines.push("| -------- | --------- | --------- | --------------------------- | ------------ |");
    for (const c of conflicts) {
      lines.push(
        `| ${c.table.padEnd(8)} | ${c.rowId.slice(0, 8)} | ${(c.type ?? "").padEnd(9)} | ${(c.conflictReason ?? "").padEnd(27)} | ${c.diffSummary} |`,
      );
    }
  }
  lines.push("");

  // ## Embeddings to re-compute
  // Lazy strategy chosen (design doc Q2 still open — pick lazy for first dry-run,
  // operator can override later).
  const m2cNotes = plan.notes.filter((c) => c.direction === "M2C").length;
  const c2mNotes = plan.notes.filter((c) => c.direction === "C2M").length;
  lines.push("## Embeddings to re-compute");
  lines.push(`- on M (post-apply): ${c2mNotes}`);
  lines.push(`- on C (post-apply): ${m2cNotes}`);
  lines.push("");

  // ## Footer
  const m2cActivity = plan.activity.filter((c) => c.direction === "M2C").length;
  const c2mActivity = plan.activity.filter((c) => c.direction === "C2M").length;
  const estSeconds = Math.max(
    1,
    Math.ceil(
      (m2cNotes + c2mNotes + m2cActivity + c2mActivity) * 0.02 +
        (m2cNotes + c2mNotes) * 0.15,
    ),
  );
  lines.push("## Footer");
  lines.push(`- M2C notes inserts: ${plan.notes.filter((c) => c.direction === "M2C" && c.remoteUpdatedAtMs === 0).length}`);
  lines.push(`- M2C notes updates: ${plan.notes.filter((c) => c.direction === "M2C" && c.remoteUpdatedAtMs > 0).length}`);
  lines.push(`- C2M notes inserts: ${plan.notes.filter((c) => c.direction === "C2M" && c.localUpdatedAtMs === 0).length}`);
  lines.push(`- C2M notes updates: ${plan.notes.filter((c) => c.direction === "C2M" && c.localUpdatedAtMs > 0).length}`);
  lines.push(`- M2C activity inserts: ${m2cActivity}`);
  lines.push(`- C2M activity inserts: ${c2mActivity}`);
  lines.push(`- Conflicts detected (count only — not written in dry-run): ${conflicts.length}`);
  lines.push(`- Embeddings to re-compute on M: ${c2mNotes}`);
  lines.push(`- Embeddings to re-compute on C: ${m2cNotes}`);
  lines.push(`- Estimated apply duration: ${estSeconds}s`);
  lines.push(`- Rows in report: ${notesRendered.length + actRendered.length} / ${cap} cap`);
  if (truncated) lines.push("- TRUNCATED: candidate set exceeds 500-row cap — REVIEW_REQUIRED");
  lines.push("");
  return lines.join("\n");
}

export function writeReport(report: string, outPath: string): void {
  writeFileSync(outPath, report);
}

/**
 * Compute the dry-run report sha256 EXCLUDING the timestamp label in the
 * first line. Used by the idempotency proof: two dry-runs against the same
 * snapshot pair produce identical hashes regardless of when they ran.
 */
export function reportBodyHash(report: string): string {
  const body = report.replace(/^# Shadow sync dry-run — .*\n/, "# Shadow sync dry-run\n");
  return createHash("sha256").update(body).digest("hex");
}

// ============================================================================
// --apply data-mutation path (WS-4 safety rebuild).
//
// Realizes a SyncPlan by mutating ONLY the target (Corsair) DB for direction
// M2C. The Mac mini DB is opened read-only and NEVER written — ring migration
// is a one-time directional convergence Mac→Corsair (see design finding in the
// Item C preflight note: `notes` has no per-agent key, so a per-agent notes
// filter is not expressible; the safe primitive is an explicit directional
// apply with an optional table filter).
//
// Hard rules enforced here:
//   - direction === "conflict" rows are NEVER applied. Revalidated conflict
//     envelopes are queued atomically, then the data apply is refused.
//   - non-conflict mutations run inside ONE target transaction under a stable
//     source read snapshot; any error rolls back fully.
//   - sync_applied_hashes records the source-side row hash AFTER each mutation
//     succeeds; a row whose hash is already present is an idempotent no-op.
//   - results are COUNTS ONLY — never row body bytes (privacy rubric §7).
// ============================================================================

export interface ApplyTableResult {
  inserted: number;
  updated: number;
  hashesRecorded: number;
  conflictsBlocked: number;
  skippedIdempotent: number;
}

export interface ApplyResult {
  notes: ApplyTableResult;
  activity: ApplyTableResult;
  direction: "M2C";
  transaction: "committed" | "rolled_back";
}

export interface ApplyOptions {
  /** Target Corsair DB, opened READ-WRITE. */
  corDbPath: string;
  /** Source Mac DB, opened READ-ONLY (never written). */
  macDbPath: string;
  /** Only M2C is supported for ring migration (C2M would mutate the source). */
  direction?: "M2C";
  /** Optional single-table scope; default applies both notes + activity. */
  table?: "notes" | "activity";
  /** origin_host stamp the receiver writes onto incoming activity rows. */
  sourceHost?: string;
  /** Test-only fault injection: called before each row mutation; throw to abort. */
  _injectFault?: (rowId: string) => void;
}

export const SYNC_BUSY_TIMEOUT_MS = SQLITE_BUSY_TIMEOUT_MS;

/** Connection-local safety required for every writable shadow-sync handle. */
export function configureWritableSyncConnection(db: Database): void {
  configureWritableDatabase(db, { busyTimeoutMs: SYNC_BUSY_TIMEOUT_MS });
}

function emptyTableResult(): ApplyTableResult {
  return { inserted: 0, updated: 0, hashesRecorded: 0, conflictsBlocked: 0, skippedIdempotent: 0 };
}

function tableColumns(db: Database, table: string): string[] {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

function readRowById(
  db: Database,
  table: "notes" | "activity",
  rowId: string,
): Record<string, unknown> | undefined {
  return db.query(`SELECT * FROM ${table} WHERE id = ?`).get(rowId) as
    | Record<string, unknown>
    | undefined;
}

function currentRowHash(
  table: "notes" | "activity",
  row: Record<string, unknown>,
): string {
  return table === "notes"
    ? notesHash(row as unknown as NoteRow)
    : activityHash(row as unknown as ActivityRow);
}

function assertDistinctDatabaseFiles(macDbPath: string, corDbPath: string): void {
  const mac = statSync(macDbPath);
  const cor = statSync(corDbPath);
  if (mac.dev === cor.dev && mac.ino === cor.ino) {
    throw new Error("apply refused: source and target resolve to the same database file");
  }
}

function assertCandidateStillMatchesPlan(
  source: Database,
  target: Database,
  table: "notes" | "activity",
  candidate: Candidate,
): {
  sourceRow: Record<string, unknown>;
  targetRow: Record<string, unknown> | undefined;
  sourceHash: string;
  targetHash: string;
} {
  const sourceRow = readRowById(source, table, candidate.rowId);
  if (!sourceRow) {
    throw new Error(`STALE_PLAN: source row missing for ${table}/${candidate.rowId}`);
  }
  const sourceHash = currentRowHash(table, sourceRow);
  if (sourceHash !== candidate.localHash) {
    throw new Error(`STALE_PLAN: source row changed for ${table}/${candidate.rowId}`);
  }

  const targetRow = readRowById(target, table, candidate.rowId);
  const targetHash = targetRow ? currentRowHash(table, targetRow) : "";
  return { sourceRow, targetRow, sourceHash, targetHash };
}

export function applyPlan(plan: SyncPlan, opts: ApplyOptions): ApplyResult {
  const direction = opts.direction ?? "M2C";
  if (direction !== "M2C") {
    throw new Error(
      `apply refused: only direction M2C is supported (got ${direction}); ` +
        `C2M would mutate the Mac source DB which is forbidden for ring migration`,
    );
  }
  const sourceHost = opts.sourceHost ?? "mac-mini";
  const tablesInScope: Array<"notes" | "activity"> = opts.table
    ? [opts.table]
    : ["notes", "activity"];

  if (!existsSync(opts.macDbPath)) throw new Error(`apply source DB not found: ${opts.macDbPath}`);
  if (!existsSync(opts.corDbPath)) throw new Error(`apply target DB not found: ${opts.corDbPath}`);
  assertDistinctDatabaseFiles(opts.macDbPath, opts.corDbPath);

  const source = openReadonlyDatabase(opts.macDbPath);
  const target = openWritableDatabase(opts.corDbPath, {
    busyTimeoutMs: SYNC_BUSY_TIMEOUT_MS,
  });
  const result: ApplyResult = {
    notes: emptyTableResult(),
    activity: emptyTableResult(),
    direction: "M2C",
    transaction: "rolled_back",
  };

  try {
    // Applying a signed plan atop an already-corrupt target makes attribution
    // and rollback ambiguous. Refuse before the first transaction/write.
    assertDatabaseIntegrity(target, "shadow-sync target");
    const targetCols: Record<string, string[]> = {};
    for (const t of tablesInScope) {
      targetCols[t] = tableColumns(target, t);
    }
    const targetHasUpdatedAtMs = targetCols.notes
      ? targetCols.notes.includes("updated_at_ms")
      : false;

    const hashExists = target.query(
      "SELECT 1 FROM sync_applied_hashes WHERE hash = ?",
    );
    const recordHash = target.query(
      "INSERT INTO sync_applied_hashes (hash, table_name, row_id, direction) VALUES (?, ?, ?, 'M2C')",
    );

    // A conflict is a real persisted workflow: revalidate both envelopes,
    // queue them atomically on the writable target, commit no data rows, then
    // abort apply so an operator must review and reconcile the drift.
    const conflicts = tablesInScope.flatMap((table) =>
      plan[table]
        .filter((candidate) => candidate.direction === "conflict")
        .map((candidate) => ({ table, candidate })),
    );
    if (conflicts.length > 0) {
      const persistConflicts = source.transaction(() => {
        const persistTarget = target.transaction(() => {
          for (const { table, candidate } of conflicts) {
            const current = assertCandidateStillMatchesPlan(
              source,
              target,
              table,
              candidate,
            );
            if (current.targetHash !== candidate.remoteHash) {
              throw new Error(
                `STALE_PLAN: target row changed for ${table}/${candidate.rowId}`,
              );
            }
            target.query(
              `INSERT INTO sync_conflict_queue
                 (table_name, row_id, direction,
                  local_updated_at_ms, remote_updated_at_ms,
                  local_hash, remote_hash, field_diff_summary)
               SELECT ?, ?, 'M2C', ?, ?, ?, ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM sync_conflict_queue
                   WHERE table_name = ? AND row_id = ? AND direction = 'M2C'
                     AND local_hash = ? AND remote_hash = ? AND status = 'pending'
                )`,
            ).run(
              table,
              candidate.rowId,
              candidate.localUpdatedAtMs,
              candidate.remoteUpdatedAtMs,
              candidate.localHash,
              candidate.remoteHash,
              candidate.diffSummary,
              table,
              candidate.rowId,
              candidate.localHash,
              candidate.remoteHash,
            );
            result[table].conflictsBlocked++;
          }
        });
        persistTarget();
      });
      persistConflicts();
      throw new Error(
        `apply aborted: ${conflicts.length} conflict candidate(s) queued for review`,
      );
    }

    const applyWithSourceSnapshot = source.transaction(() => {
      const applyTarget = target.transaction(() => {
        for (const t of tablesInScope) {
          const tr = result[t];
          const candidates = plan[t].filter((c) => c.direction === "M2C");
          for (const c of candidates) {
            const current = assertCandidateStillMatchesPlan(source, target, t, c);
            const hashAlreadyApplied =
              (hashExists.get(current.sourceHash) as unknown) != null;

            if (
              hashAlreadyApplied &&
              current.targetHash === current.sourceHash
            ) {
              tr.skippedIdempotent++;
              continue;
            }
            if (hashAlreadyApplied) {
              throw new Error(
                `STALE_PLAN: applied hash exists but target diverged for ${t}/${c.rowId}`,
              );
            }
            if (current.targetHash !== c.remoteHash) {
              throw new Error(`STALE_PLAN: target row changed for ${t}/${c.rowId}`);
            }
            if (opts._injectFault) opts._injectFault(c.rowId);

            const rowObj: Record<string, unknown> = { ...current.sourceRow };
            if (t === "activity") {
              rowObj.origin_host = sourceHost;
            }
            if (t === "notes" && targetHasUpdatedAtMs) {
              rowObj.updated_at_ms = effectiveUpdatedAtMs(
                current.sourceRow as unknown as NoteRow,
              );
            }

            const writeCols = targetCols[t].filter((col) => col in rowObj);
            if (!current.targetRow) {
              const placeholders = writeCols.map(() => "?").join(", ");
              target
                .query(
                  `INSERT INTO ${t} (${writeCols.join(", ")}) VALUES (${placeholders})`,
                )
                .run(...writeCols.map((col) => rowObj[col] as any));
              tr.inserted++;
            } else {
              const setCols = writeCols.filter((col) => col !== "id");
              const setClause = setCols.map((col) => `${col} = ?`).join(", ");
              target
                .query(`UPDATE ${t} SET ${setClause} WHERE id = ?`)
                .run(...setCols.map((col) => rowObj[col] as any), c.rowId);
              tr.updated++;
            }

            const written = readRowById(target, t, c.rowId);
            if (!written || currentRowHash(t, written) !== current.sourceHash) {
              throw new Error(
                `apply integrity error: written row hash mismatch for ${t}/${c.rowId}`,
              );
            }
            recordHash.run(current.sourceHash, t, c.rowId);
            tr.hashesRecorded++;
          }
        }
      });
      applyTarget();
    });

    applyWithSourceSnapshot();
    result.transaction = "committed";
    return result;
  } finally {
    source.close();
    target.close();
  }
}

/**
 * Render the apply report. COUNTS ONLY — never row body bytes (rubric §7).
 * Deterministic given the same ApplyResult + verify summary.
 */
export function renderApplyReport(
  result: ApplyResult,
  tsLabel: string,
  verify: { residualNotesM2c: number; residualActivityM2c: number },
): string {
  const parityOk = verify.residualNotesM2c === 0 && verify.residualActivityM2c === 0;
  const lines: string[] = [];
  lines.push(`# Shadow sync apply — ${tsLabel}`);
  lines.push(`- Direction: ${result.direction} (Mac mini → Corsair)`);
  lines.push(`- Transaction: ${result.transaction}`);
  lines.push("");
  lines.push("## Counts (no body bytes)");
  lines.push("| table    | inserted | updated | hashes_recorded | skipped_idempotent |");
  lines.push("| -------- | -------- | ------- | --------------- | ------------------ |");
  for (const t of ["notes", "activity"] as const) {
    const r = result[t];
    lines.push(
      `| ${t.padEnd(8)} | ${String(r.inserted).padEnd(8)} | ${String(r.updated).padEnd(7)} | ${String(r.hashesRecorded).padEnd(15)} | ${String(r.skippedIdempotent).padEnd(18)} |`,
    );
  }
  lines.push("");
  lines.push("## Post-apply verification");
  lines.push(`- residual M2C notes: ${verify.residualNotesM2c}`);
  lines.push(`- residual M2C activity: ${verify.residualActivityM2c}`);
  lines.push(`- parity: ${parityOk ? "OK (applied direction empty)" : "FAIL"}`);
  lines.push("");
  return lines.join("\n");
}

export interface ApplyAuthorizationPayload {
  version: 1;
  operation: "shadow-sync-apply";
  run_id: string;
  direction: "M2C";
  mac_db_path: string;
  cor_db_path: string;
  plan_sha256: string;
  review_id: string;
  owner_approval_id: string;
  issued_at: string;
  expires_at: string;
}

export interface ApplyAuthorizationManifest extends ApplyAuthorizationPayload {
  signature: string;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_MANIFEST_TTL_MS = 60 * 60_000;

export function planFingerprint(plan: SyncPlan): string {
  const stable = JSON.parse(
    JSON.stringify({ notes: plan.notes, activity: plan.activity }),
  );
  return createHash("sha256").update(canonicalJson(stable)).digest("hex");
}

function manifestPayload(
  manifest: ApplyAuthorizationManifest,
): ApplyAuthorizationPayload {
  const { signature: _signature, ...payload } = manifest;
  return payload;
}

function manifestSignature(
  payload: ApplyAuthorizationPayload,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(canonicalJson(payload))
    .digest("hex");
}

function validAuthorizationSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 32;
}

function canonicalDbPath(dbPath: string): string {
  if (!existsSync(dbPath)) throw new Error(`database path not found: ${dbPath}`);
  return realpathSync(dbPath);
}

export function createApplyAuthorizationManifest(args: {
  secret: string;
  plan: SyncPlan;
  macDbPath: string;
  corDbPath: string;
  runId: string;
  reviewId: string;
  ownerApprovalId: string;
  issuedAt: string;
  expiresAt: string;
}): ApplyAuthorizationManifest {
  if (!validAuthorizationSecret(args.secret)) {
    throw new Error("SHADOW_SYNC_APPLY_AUTHORIZED must contain at least 32 bytes");
  }
  if (!ULID_RE.test(args.runId)) throw new Error("runId must be a Qoopia ULID");
  if (!ULID_RE.test(args.reviewId)) throw new Error("reviewId must be a Qoopia ULID");
  if (!ULID_RE.test(args.ownerApprovalId)) {
    throw new Error("ownerApprovalId must be a Qoopia ULID");
  }
  const payload: ApplyAuthorizationPayload = {
    version: 1,
    operation: "shadow-sync-apply",
    run_id: args.runId,
    direction: "M2C",
    mac_db_path: canonicalDbPath(args.macDbPath),
    cor_db_path: canonicalDbPath(args.corDbPath),
    plan_sha256: planFingerprint(args.plan),
    review_id: args.reviewId,
    owner_approval_id: args.ownerApprovalId,
    issued_at: args.issuedAt,
    expires_at: args.expiresAt,
  };
  return { ...payload, signature: manifestSignature(payload, args.secret) };
}

export function validateApplyAuthorizationManifest(args: {
  secret: string | undefined;
  manifest: ApplyAuthorizationManifest;
  plan: SyncPlan;
  macDbPath: string;
  corDbPath: string;
  nowMs?: number;
}): string | null {
  if (!validAuthorizationSecret(args.secret)) {
    return "env SHADOW_SYNC_APPLY_AUTHORIZED must contain at least 32 bytes";
  }
  const m = args.manifest;
  if (m.version !== 1 || m.operation !== "shadow-sync-apply" || m.direction !== "M2C") {
    return "authorization manifest operation/version/direction is invalid";
  }
  if (!ULID_RE.test(m.run_id) || !ULID_RE.test(m.review_id) || !ULID_RE.test(m.owner_approval_id)) {
    return "authorization manifest ids must be Qoopia ULIDs";
  }
  let macPath: string;
  let corPath: string;
  try {
    macPath = canonicalDbPath(args.macDbPath);
    corPath = canonicalDbPath(args.corDbPath);
  } catch (error) {
    return String(error);
  }
  if (m.mac_db_path !== macPath || m.cor_db_path !== corPath) {
    return "authorization manifest database paths do not match this run";
  }
  if (m.plan_sha256 !== planFingerprint(args.plan)) {
    return "authorization manifest plan fingerprint does not match this run";
  }

  const issuedAt = Date.parse(m.issued_at);
  const expiresAt = Date.parse(m.expires_at);
  const now = args.nowMs ?? Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return "authorization manifest timestamps are invalid";
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MANIFEST_TTL_MS) {
    return "authorization manifest TTL must be positive and no longer than 60 minutes";
  }
  if (issuedAt > now + 5 * 60_000) return "authorization manifest is not yet valid";
  if (expiresAt <= now) return "authorization manifest has expired";

  if (!/^[0-9a-f]{64}$/.test(m.signature)) {
    return "authorization manifest signature is malformed";
  }
  const expected = Buffer.from(
    manifestSignature(manifestPayload(m), args.secret),
    "hex",
  );
  const actual = Buffer.from(m.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return "authorization manifest signature is invalid";
  }
  return null;
}

/** --apply gate. Dry-run always bypasses it. */
export function checkApplyGate(args: {
  apply: boolean;
  envToken: string | undefined;
  manifest?: ApplyAuthorizationManifest;
  plan?: SyncPlan;
  macDbPath?: string;
  corDbPath?: string;
  nowMs?: number;
}): string | null {
  if (!args.apply) return null;
  if (!args.manifest) {
    return "HOLD: --apply refused; missing --authorization-manifest <path>";
  }
  if (!args.plan || !args.macDbPath || !args.corDbPath) {
    return "HOLD: --apply refused; authorization manifest cannot be bound to a plan";
  }
  const error = validateApplyAuthorizationManifest({
    secret: args.envToken,
    manifest: args.manifest,
    plan: args.plan,
    macDbPath: args.macDbPath,
    corDbPath: args.corDbPath,
    nowMs: args.nowMs,
  });
  return error ? `HOLD: --apply refused; ${error}` : null;
}

// Re-export commonly-needed types for the CLI + tests.
