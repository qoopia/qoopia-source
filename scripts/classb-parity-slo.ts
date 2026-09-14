#!/usr/bin/env bun
/**
 * Class B parity + SLO harness.
 *
 * Produces a privacy-safe JSON evidence report that lets us prove, across a
 * code+schema change (prod-head fcafe8c vs RC 1005ac04):
 *
 *   (a) Flag-OFF byte-identical output of recall / note_get / note_list
 *       — captured as sha256 digests + byte lengths, never plaintext.
 *   (b) p50 / p95 / min / max / mean latency for the SLO query shape
 *       (recall, deep=false, deep_llm=false, is_admin=false).
 *
 * The script is deliberately restricted to the API surface that exists in
 * BOTH trees:
 *   src/services/recall.ts  -> recall(p: RecallParams), getRecallMode()
 *       common params: workspace_id, caller_agent_id, is_admin, query,
 *                      limit, deep, deep_llm
 *   src/services/notes.ts   -> getNote(workspace_id, id, caller_agent_id, isAdmin)
 *                              listNotes(p: NoteListParams)
 *   src/db/connection.ts    -> db  (the app's own handle)
 *
 * Every module that touches src/db/connection.ts is loaded through a dynamic
 * import AFTER the environment has been pinned, because connection.ts opens
 * the database at module-evaluation time from env.DATA_DIR
 * (src/utils/runtime-config.ts: QOOPIA_DATA_DIR || QOOPIA_ROOT/data) and
 * hard-codes the file name `qoopia.db`.
 *
 * SAFETY
 *   - The database passed via --db is NEVER opened by the app connection
 *     layer. It is copied into a private 0700 scratch directory first (the
 *     app opens writable + WAL, which would rewrite the journal header).
 *     Use --no-copy only when the input is already a throwaway file.
 *   - The source file's sha256 is measured before and after the run and both
 *     values are recorded, so "we did not mutate it" is evidence, not a claim.
 *   - The report contains no note text, titles, metadata values, query terms,
 *     workspace names, agent names, tokens or secrets. Query terms appear
 *     only as a sha256 over the term list.
 *
 * Usage:
 *   bun scripts/classb-parity-slo.ts \
 *       --db /path/to/qoopia.db \
 *       --out /path/to/report.json \
 *       --label baseline-prodhead \
 *       [--iterations 60] [--no-copy] [--keep-scratch]
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  db: string;
  out: string;
  label: string;
  iterations: number;
  copy: boolean;
  keepScratch: boolean;
  bitemporal: boolean;
}

function parseCli(argv: string[]): Cli {
  const opts = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      opts.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts.set(name, next);
      i++;
    } else {
      flags.add(name);
    }
  }

  const missing: string[] = [];
  for (const required of ["db", "out", "label"]) {
    if (!opts.get(required)?.trim()) missing.push(`--${required}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `missing required option(s): ${missing.join(", ")}\n` +
        `usage: bun scripts/classb-parity-slo.ts --db <sqlite> --out <json> ` +
        `--label <string> [--iterations 60] [--no-copy] [--keep-scratch] [--bitemporal]`,
    );
  }

  const rawIterations = opts.get("iterations");
  const iterations = rawIterations === undefined ? 60 : Number(rawIterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) {
    throw new Error(`--iterations must be an integer from 1 through 100000`);
  }

  return {
    db: path.resolve(opts.get("db")!.trim()),
    out: path.resolve(opts.get("out")!.trim()),
    label: opts.get("label")!.trim(),
    iterations,
    copy: !flags.has("no-copy"),
    keepScratch: flags.has("keep-scratch"),
    bitemporal: flags.has("bitemporal"),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface Digest {
  sha256: string;
  bytes: number;
}

function digestOf(value: unknown): Digest {
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json, "utf8");
  return { sha256: createHash("sha256").update(json, "utf8").digest("hex"), bytes };
}

function fileSha256(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Error class name only — messages may embed note content or ids. */
function errClass(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code)
      ? `${e.constructor?.name ?? "Error"}:${code}`
      : (e.constructor?.name ?? "Error");
  }
  return typeof e;
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

function round3(n: number): number {
  return Number(n.toFixed(3));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const errors: string[] = [];

  if (!fs.existsSync(cli.db) || !fs.statSync(cli.db).isFile()) {
    throw new Error(`--db is not a readable file: ${cli.db}`);
  }

  const sourceShaBefore = fileSha256(cli.db);

  // -- pin the environment BEFORE anything imports src/db/connection.ts ------
  //
  // runtime-config resolves DATA_DIR from QOOPIA_DATA_DIR (fallback
  // QOOPIA_ROOT/data) and connection.ts joins "qoopia.db" onto it, so the
  // directory must contain a file literally named qoopia.db.
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "classb-parity-"));
  fs.chmodSync(scratchRoot, 0o700);
  const dataDir = path.join(scratchRoot, "data");
  const logDir = path.join(scratchRoot, "logs");
  const backupDir = path.join(scratchRoot, "backups");
  for (const dir of [dataDir, logDir, backupDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  let effectiveDbDir: string;
  let copied: boolean;
  if (cli.copy) {
    fs.copyFileSync(cli.db, path.join(dataDir, "qoopia.db"));
    fs.chmodSync(path.join(dataDir, "qoopia.db"), 0o600);
    // Sidecars, when present, belong to the same logical database.
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${cli.db}${suffix}`;
      if (fs.existsSync(side)) {
        fs.copyFileSync(side, path.join(dataDir, `qoopia.db${suffix}`));
        fs.chmodSync(path.join(dataDir, `qoopia.db${suffix}`), 0o600);
      }
    }
    effectiveDbDir = dataDir;
    copied = true;
  } else {
    if (path.basename(cli.db) !== "qoopia.db") {
      throw new Error(
        `--no-copy requires the database file to be named qoopia.db (got ${path.basename(cli.db)})`,
      );
    }
    effectiveDbDir = path.dirname(cli.db);
    copied = false;
  }

  process.env.QOOPIA_ROOT = scratchRoot;
  process.env.QOOPIA_DATA_DIR = effectiveDbDir;
  process.env.QOOPIA_LOG_DIR = logDir;
  process.env.QOOPIA_BACKUP_DIR = backupDir;
  process.env.QOOPIA_SERVER_ROLE = "canonical";
  process.env.QOOPIA_LOG_LEVEL = process.env.QOOPIA_LOG_LEVEL || "error";
  // Flag-OFF is the parity baseline; --bitemporal captures the same shapes
  // with the flag ON so the two reports can be diffed digest-for-digest.
  if (cli.bitemporal) process.env.QOOPIA_V4_BITEMPORAL = "true";
  else delete process.env.QOOPIA_V4_BITEMPORAL;

  // Non-secret record of which V4-ish switches were live in the shell. Names
  // and a boolean only — values are never copied into the report.
  const v4EnvNames = Object.keys(process.env)
    .filter((k) => /^QOOPIA_(V4|RECALL|RERANK)/.test(k))
    .sort();
  const envFlagsPresent = Object.fromEntries(
    v4EnvNames.map((k) => [k, (process.env[k] ?? "").trim().length > 0]),
  );

  // -- dynamic imports (must be after the env pin) --------------------------
  const { db } = (await import("../src/db/connection.ts")) as {
    db: {
      prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
      query?: (sql: string) => { get: () => unknown };
      close?: () => void;
    };
  };
  const recallMod = (await import("../src/services/recall.ts")) as unknown as {
    recall: (p: Record<string, unknown>) => Promise<{ results?: unknown[] }>;
    getRecallMode?: () => string;
  };
  const notesMod = (await import("../src/services/notes.ts")) as unknown as {
    getNote: (workspace_id: string, id: string, caller_agent_id: string, isAdmin: boolean) => unknown;
    listNotes: (p: Record<string, unknown>) => unknown;
  };

  const all = (sql: string, ...args: unknown[]): any[] => db.prepare(sql).all(...args) as any[];
  const one = (sql: string, ...args: unknown[]): any => db.prepare(sql).get(...args);

  // -- deterministic fixture selection --------------------------------------

  const wsRow = one(
    `SELECT workspace_id, COUNT(*) c FROM notes
      WHERE deleted_at IS NULL
      GROUP BY workspace_id
      ORDER BY c DESC, workspace_id ASC
      LIMIT 1`,
  ) as { workspace_id: string; c: number } | undefined;
  if (!wsRow) throw new Error("no non-deleted notes in the database — nothing to measure");
  const workspaceId = wsRow.workspace_id;

  // Agent selection: deterministic (id ASC), preferring a normal non-admin
  // agent so the private-note filter is actually exercised.
  const agentCols = new Set(
    (all(`PRAGMA table_info(agents)`) as Array<{ name: string }>).map((r) => r.name),
  );
  const hasAgentType = agentCols.has("type");
  const hasAgentActive = agentCols.has("active");
  const ADMIN_TYPES = ["steward", "claude-privileged", "admin"];

  const agentRows = all(
    `SELECT id${hasAgentType ? ", type" : ""}${hasAgentActive ? ", active" : ""}
       FROM agents WHERE workspace_id = ? ORDER BY id ASC`,
    workspaceId,
  ) as Array<{ id: string; type?: string; active?: number }>;

  let agentSelection = "none";
  let callerAgentId: string;
  const pickBy = (pred: (r: { id: string; type?: string; active?: number }) => boolean) =>
    agentRows.find(pred);

  const nonAdminActive = hasAgentType
    ? pickBy((r) => !ADMIN_TYPES.includes(String(r.type)) && (!hasAgentActive || r.active === 1))
    : undefined;
  const nonAdminAny = hasAgentType
    ? pickBy((r) => !ADMIN_TYPES.includes(String(r.type)))
    : undefined;

  if (nonAdminActive) {
    callerAgentId = nonAdminActive.id;
    agentSelection = "first_non_admin_active_by_id_asc";
  } else if (nonAdminAny) {
    callerAgentId = nonAdminAny.id;
    agentSelection = "first_non_admin_by_id_asc";
  } else if (agentRows.length > 0) {
    callerAgentId = agentRows[0]!.id;
    agentSelection = "first_agent_by_id_asc";
  } else {
    // No agent rows for this workspace: fall back to a fixed synthetic id so
    // the run is still deterministic and reproducible on both trees.
    callerAgentId = "00000000000000000000000000";
    agentSelection = "synthetic_zero_id_no_agent_rows";
  }

  // Deterministic query terms derived from the data itself.
  const noteCols = new Set(
    (all(`PRAGMA table_info(notes)`) as Array<{ name: string }>).map((r) => r.name),
  );
  const textCol = ["title", "text", "content", "body"].find((c) => noteCols.has(c));
  if (!textCol) throw new Error("notes table exposes no text-ish column to derive terms from");

  const termSeedRows = all(
    `SELECT id, ${textCol} AS body FROM notes WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 5`,
  ) as Array<{ id: string; body: string | null }>;

  const TOKEN_RE = /[\p{L}\p{N}]{4,32}/gu;
  const terms: string[] = [];
  for (const row of termSeedRows) {
    const tokens = String(row.body ?? "").match(TOKEN_RE) ?? [];
    // First token of length >= 4 is stable for a given row body.
    terms.push((tokens[0] ?? "qoopia").toLowerCase());
  }
  while (terms.length < 5) terms.push("qoopia");

  const noteIds = (
    all(`SELECT id FROM notes WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 10`) as Array<{
      id: string;
    }>
  ).map((r) => r.id);

  // -- SLO shape ------------------------------------------------------------
  //
  // Common param names in both trees' RecallParams: workspace_id,
  // caller_agent_id, is_admin, query, limit, deep, deep_llm.
  const RECALL_LIMIT = 50;
  const recallParams = (query: string) => ({
    workspace_id: workspaceId,
    caller_agent_id: callerAgentId,
    is_admin: false,
    query,
    limit: RECALL_LIMIT,
    deep: false,
    deep_llm: false,
  });

  const WARMUP = 5;
  let recallAttempts = 0;
  let recallFailures = 0;

  const runRecall = async (query: string): Promise<{ results: unknown[] | null; ms: number }> => {
    recallAttempts++;
    const t0 = performance.now();
    try {
      const res = await recallMod.recall(recallParams(query));
      const ms = performance.now() - t0;
      return { results: Array.isArray(res?.results) ? res.results : [], ms };
    } catch (e) {
      const ms = performance.now() - t0;
      recallFailures++;
      errors.push(`recall:${errClass(e)}`);
      return { results: null, ms };
    }
  };

  for (let i = 0; i < WARMUP; i++) {
    await runRecall(terms[i % terms.length]!);
  }

  const samples: number[] = [];
  for (let i = 0; i < cli.iterations; i++) {
    const { ms } = await runRecall(terms[i % terms.length]!);
    samples.push(ms);
  }

  // -- parity captures ------------------------------------------------------

  // recall_results: concatenated in term order.
  const recallCapture: unknown[] = [];
  let recallCaptureFailures = 0;
  for (const term of terms) {
    const { results } = await runRecall(term);
    if (results === null) recallCaptureFailures++;
    recallCapture.push(results);
  }

  // note_get
  const noteGetCapture: unknown[] = [];
  for (const id of noteIds) {
    try {
      noteGetCapture.push(notesMod.getNote(workspaceId, id, callerAgentId, false));
    } catch (e) {
      errors.push(`note_get:${errClass(e)}`);
      noteGetCapture.push(null);
    }
  }

  // note_list — fixed ordering + fixed limit for stability.
  const NOTE_LIST_LIMIT = 100;
  let noteListCapture: unknown = null;
  try {
    noteListCapture = notesMod.listNotes({
      workspace_id: workspaceId,
      caller_agent_id: callerAgentId,
      is_admin: false,
      limit: NOTE_LIST_LIMIT,
      offset: 0,
      order: "created_asc",
    });
  } catch (e) {
    errors.push(`note_list:${errClass(e)}`);
  }

  // raw_notes_metadata — column set is probed so the script also runs against
  // a pre-033 schema that lacks updated_at_ms.
  const rawCols = ["id", "metadata", "updated_at", "updated_at_ms"].filter((c) =>
    noteCols.has(c),
  );
  let rawNotesCapture: unknown = null;
  try {
    rawNotesCapture = all(`SELECT ${rawCols.join(", ")} FROM notes ORDER BY id`);
  } catch (e) {
    errors.push(`raw_notes_metadata:${errClass(e)}`);
  }

  let pragmaForeignKeys: number | null = null;
  try {
    pragmaForeignKeys = Number((one(`PRAGMA foreign_keys`) as { foreign_keys: number }).foreign_keys);
  } catch (e) {
    errors.push(`pragma_foreign_keys:${errClass(e)}`);
  }

  let schemaVersion: number | null = null;
  try {
    schemaVersion = Number((one(`SELECT MAX(version) v FROM schema_versions`) as { v: number }).v);
  } catch (e) {
    errors.push(`schema_version:${errClass(e)}`);
  }

  // -- report ---------------------------------------------------------------

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);

  const digests = {
    recall_results: digestOf(recallCapture),
    note_get: digestOf(noteGetCapture),
    note_list: digestOf(noteListCapture),
    raw_notes_metadata: digestOf(rawNotesCapture),
    pragma_foreign_keys: digestOf(pragmaForeignKeys),
    schema_version: digestOf(schemaVersion),
    query_terms: digestOf(terms), // terms NEVER appear in plaintext
  };

  const sourceShaAfter = fileSha256(cli.db);

  const report = {
    schema: "classb-parity-slo/1",
    label: cli.label,
    generated_at: new Date().toISOString(),
    runtime: {
      bun: typeof Bun !== "undefined" ? Bun.version : null,
      platform: process.platform,
      arch: process.arch,
    },
    database: {
      source_path: cli.db,
      source_sha256_before: sourceShaBefore,
      source_sha256_after: sourceShaAfter,
      source_unmodified: sourceShaBefore === sourceShaAfter,
      opened_via: "src/db/connection.ts (QOOPIA_DATA_DIR/qoopia.db)",
      opened_on_copy: copied,
      pragma_foreign_keys: pragmaForeignKeys,
      schema_version: schemaVersion,
      raw_notes_columns: rawCols,
    },
    flags: {
      QOOPIA_V4_BITEMPORAL: cli.bitemporal ? "true (flag-ON)" : "unset (flag-OFF)",
      QOOPIA_SERVER_ROLE: "canonical",
      recall_mode: (() => {
        try {
          return recallMod.getRecallMode?.() ?? "unknown";
        } catch {
          return "unknown";
        }
      })(),
      env_present: envFlagsPresent,
    },
    fixture: {
      workspace_id: workspaceId,
      workspace_note_count: wsRow.c,
      caller_agent_id: callerAgentId,
      caller_agent_selection: agentSelection,
      caller_agent_is_admin: false,
      note_ids: noteIds,
      note_id_count: noteIds.length,
      term_count: terms.length,
      term_source_column: textCol,
      terms_sha256: digests.query_terms.sha256,
    },
    slo: {
      shape: "recall(deep=false, deep_llm=false, is_admin=false)",
      params_used: ["workspace_id", "caller_agent_id", "is_admin", "query", "limit", "deep", "deep_llm"],
      limit: RECALL_LIMIT,
      warmup_iterations: WARMUP,
      iterations: cli.iterations,
      samples: samples.length,
      p50_ms: round3(percentile(sorted, 50)),
      p95_ms: round3(percentile(sorted, 95)),
      min_ms: round3(sorted[0] ?? 0),
      max_ms: round3(sorted[sorted.length - 1] ?? 0),
      mean_ms: round3(mean),
      percentile_method: "nearest-rank",
    },
    parity: {
      recall_results: digests.recall_results,
      note_get: digests.note_get,
      note_list: digests.note_list,
      raw_notes_metadata: digests.raw_notes_metadata,
      pragma_foreign_keys: digests.pragma_foreign_keys,
      schema_version: digests.schema_version,
      query_terms: digests.query_terms,
      note_list_params: { limit: NOTE_LIST_LIMIT, offset: 0, order: "created_asc" },
    },
    counters: {
      recall_attempts: recallAttempts,
      recall_failures: recallFailures,
      recall_capture_failures: recallCaptureFailures,
      note_get_null: noteGetCapture.filter((n) => n === null).length,
    },
    errors,
  };

  fs.mkdirSync(path.dirname(cli.out), { recursive: true });
  fs.writeFileSync(cli.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(cli.out, 0o600);

  try {
    db.close?.();
  } catch {
    /* closing is best-effort; the report is already on disk */
  }
  if (!cli.keepScratch) {
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      /* scratch cleanup is best-effort */
    }
  }

  console.log(cli.out);
  console.log(
    [
      `label=${cli.label}`,
      `p50=${report.slo.p50_ms}ms`,
      `p95=${report.slo.p95_ms}ms`,
      `recall=${digests.recall_results.sha256.slice(0, 16)}`,
      `note_get=${digests.note_get.sha256.slice(0, 16)}`,
      `note_list=${digests.note_list.sha256.slice(0, 16)}`,
      `raw_notes=${digests.raw_notes_metadata.sha256.slice(0, 16)}`,
    ].join(" "),
  );

  // Hard failure only when the whole recall channel is dead.
  if (recallFailures >= recallAttempts) {
    console.error("FATAL: every recall call failed");
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`classb-parity-slo failed: ${errClass(e)}`);
    if (e instanceof Error && /^(missing required option|--|--db|--iterations)/.test(e.message)) {
      console.error(e.message);
    }
    process.exit(2);
  });
