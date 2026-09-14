import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { openReadonlyDatabase } from "./sqlite.ts";
import {
  assertV4Schema,
  computeLogicalDatabaseHash,
  readSchemaVersion,
} from "./v4-migrations.ts";

export const ACCEPTED_LEGACY_SOURCE_SHA256 =
  "5f1fac7c121c6cb05eb563617f021cd9df33351fb5cddac5fc531aa7f2cae206";
export const ACCEPTED_RECONCILIATION_MANIFEST_SHA256 =
  "dc88824bd03b8fa6d6db9798d3289082ea38421f23b05065961e1450deba7cc9";

const RECONCILIATION_KEYS = [
  "batch",
  "canonical_id",
  "reason",
  "source_hash",
  "source_id",
  "status",
] as const;

interface ReconciliationRow {
  batch: string;
  canonical_id: string;
  reason: string;
  source_hash: string;
  source_id: string;
  status: string;
}

export interface V4VerificationOptions {
  db: Database;
  dbPath: string;
  expectSchema: number;
  legacySourcePath: string;
  legacyValueFreeManifestPath: string;
  reconciliationManifestPath: string;
  expectLegacyActive: number;
}

export interface V4VerificationReport {
  ok: boolean;
  schema: {
    actual: number;
    expected: number;
    versions: number[];
    required_tables: number;
  };
  integrity: {
    quick_check: string[];
    integrity_check: string[];
    foreign_key_violations: number;
    cross_workspace_violations: number;
  };
  relations: {
    total: number;
    cycles: number;
    multiple_head_components: number;
  };
  counts: Record<string, number>;
  legacy: {
    expected_active: number;
    source_active: number;
    direct: number;
    mapped: number;
    both: number;
    covered: number;
    missing: number;
    duplicate_mappings: number;
    reconciliation_rows: number;
    reconciliation_valid: number;
    source_sha256: string;
    value_free_manifest_sha256: string;
    reconciliation_manifest_sha256: string;
  };
  hashes: {
    database_file_sha256: string;
    database_logical_sha256: string;
  };
  errors: string[];
}

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function parseValueFreeManifest(filename: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const split = line.indexOf("=");
    if (split < 1) throw new Error(`Malformed value-free manifest line`);
    const key = line.slice(0, split);
    if (key in result) throw new Error(`Duplicate value-free manifest key ${key}`);
    result[key] = line.slice(split + 1);
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseReconciliationManifest(filename: string): ReconciliationRow[] {
  const rows: ReconciliationRow[] = [];
  const allowed = new Set<string>(RECONCILIATION_KEYS);
  const forbidden = new Set([
    "text",
    "body",
    "content",
    "raw",
    "secret",
    "token",
    "password",
    "api_key",
    "bearer",
  ]);
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isPlainRecord(parsed)) throw new Error(`Invalid reconciliation row`);
    const keys = Object.keys(parsed).sort();
    if (keys.some((key) => forbidden.has(key)) ||
      keys.some((key) => !allowed.has(key)) ||
      RECONCILIATION_KEYS.some((key) => !(key in parsed))) {
      throw new Error(`Reconciliation manifest is not value-free`);
    }
    for (const key of RECONCILIATION_KEYS) {
      if (typeof parsed[key] !== "string") {
        throw new Error(`Invalid reconciliation field ${key}`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(parsed.source_hash as string)) {
      throw new Error(`Invalid reconciliation source_hash`);
    }
    rows.push(parsed as unknown as ReconciliationRow);
  }
  return rows;
}

function hasPath(
  start: string,
  goal: string,
  adjacency: Map<string, Set<string>>,
): boolean {
  const pending = [start];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

function inspectRelationGraph(db: Database): {
  total: number;
  cycles: number;
  multipleHeadComponents: number;
} {
  const rows = db
    .query(
      `SELECT workspace_id, source_note_id, target_note_id
       FROM note_relations
       WHERE relation_type = 'supersedes'
       ORDER BY workspace_id, source_note_id, target_note_id`,
    )
    .all() as Array<{
      workspace_id: string;
      source_note_id: string;
      target_note_id: string;
    }>;
  const byWorkspace = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byWorkspace.get(row.workspace_id) ?? [];
    group.push(row);
    byWorkspace.set(row.workspace_id, group);
  }

  let cycles = 0;
  let multipleHeadComponents = 0;
  for (const workspaceRows of byWorkspace.values()) {
    const adjacency = new Map<string, Set<string>>();
    const undirected = new Map<string, Set<string>>();
    const targets = new Set<string>();
    for (const row of workspaceRows) {
      const outgoing = adjacency.get(row.source_note_id) ?? new Set<string>();
      outgoing.add(row.target_note_id);
      adjacency.set(row.source_note_id, outgoing);
      if (!adjacency.has(row.target_note_id)) {
        adjacency.set(row.target_note_id, new Set());
      }
      const left = undirected.get(row.source_note_id) ?? new Set<string>();
      left.add(row.target_note_id);
      undirected.set(row.source_note_id, left);
      const right = undirected.get(row.target_note_id) ?? new Set<string>();
      right.add(row.source_note_id);
      undirected.set(row.target_note_id, right);
      targets.add(row.target_note_id);
    }
    for (const row of workspaceRows) {
      if (hasPath(row.target_note_id, row.source_note_id, adjacency)) cycles += 1;
    }
    const visited = new Set<string>();
    for (const start of undirected.keys()) {
      if (visited.has(start)) continue;
      const component = new Set<string>();
      const pending = [start];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (component.has(current)) continue;
        component.add(current);
        visited.add(current);
        for (const next of undirected.get(current) ?? []) pending.push(next);
      }
      const heads = [...component].filter((noteId) => !targets.has(noteId));
      if (heads.length > 1) multipleHeadComponents += 1;
    }
  }
  return { total: rows.length, cycles, multipleHeadComponents };
}

function countCrossWorkspaceViolations(db: Database): number {
  const checks = [
    `SELECT COUNT(*) AS count FROM note_relations r
       LEFT JOIN notes s ON s.id=r.source_note_id AND s.workspace_id=r.workspace_id
       LEFT JOIN notes t ON t.id=r.target_note_id AND t.workspace_id=r.workspace_id
       LEFT JOIN agents a ON a.id=r.created_by_agent_id AND a.workspace_id=r.workspace_id
       WHERE s.id IS NULL OR t.id IS NULL OR a.id IS NULL`,
    `SELECT COUNT(*) AS count FROM note_provenance p
       LEFT JOIN notes n ON n.id=p.note_id AND n.workspace_id=p.workspace_id
       LEFT JOIN agents a ON a.id=p.created_by_agent_id AND a.workspace_id=p.workspace_id
       WHERE n.id IS NULL OR a.id IS NULL`,
    `SELECT COUNT(*) AS count FROM memory_lifecycle l
       LEFT JOIN notes n ON n.id=l.note_id AND n.workspace_id=l.workspace_id
       WHERE n.id IS NULL`,
  ];
  return checks.reduce((total, sql) =>
    total + (db.query(sql).get() as { count: number }).count, 0);
}

export function verifyV4Database(
  options: V4VerificationOptions,
): V4VerificationReport {
  const errors: string[] = [];
  const actualSchema = readSchemaVersion(options.db);
  try {
    assertV4Schema(options.db, options.expectSchema);
  } catch (error) {
    errors.push(String(error));
  }
  const versions = (
    options.db.query("SELECT version FROM schema_versions ORDER BY version").all() as
      Array<{ version: number }>
  ).map((row) => row.version);
  if (versions.length !== options.expectSchema ||
    versions.some((version, index) => version !== index + 1)) {
    errors.push(`Schema versions are not contiguous 1..${options.expectSchema}`);
  }

  const quickCheck = (
    options.db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>
  ).map((row) => row.quick_check);
  const integrityCheck = (
    options.db.query("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>
  ).map((row) => row.integrity_check);
  const foreignKeyViolations = options.db.query("PRAGMA foreign_key_check").all().length;
  const crossWorkspaceViolations = countCrossWorkspaceViolations(options.db);
  if (quickCheck.length !== 1 || quickCheck[0] !== "ok") {
    errors.push(`quick_check failed`);
  }
  if (integrityCheck.length !== 1 || integrityCheck[0] !== "ok") {
    errors.push(`integrity_check failed`);
  }
  if (foreignKeyViolations > 0) errors.push(`foreign_key_check failed`);
  if (crossWorkspaceViolations > 0) errors.push(`cross-workspace references found`);

  const relationGraph = inspectRelationGraph(options.db);
  if (relationGraph.cycles > 0) errors.push(`supersede cycle found`);
  if (relationGraph.multipleHeadComponents > 0) {
    errors.push(`supersede component with multiple heads found`);
  }

  const valueFree = parseValueFreeManifest(options.legacyValueFreeManifestPath);
  const legacySourceSha = sha256File(options.legacySourcePath);
  const valueFreeManifestSha = sha256File(options.legacyValueFreeManifestPath);
  const reconciliationManifestSha = sha256File(options.reconciliationManifestPath);
  if (valueFree.contains_row_values !== "false") {
    errors.push(`Legacy manifest is not value-free`);
  }
  if (valueFree.sha256 !== legacySourceSha ||
    legacySourceSha !== ACCEPTED_LEGACY_SOURCE_SHA256) {
    errors.push(`Legacy source hash does not match accepted split-brain decision`);
  }
  if (valueFree.sqlite_integrity_check !== "ok") {
    errors.push(`Legacy value-free manifest integrity is not ok`);
  }
  if (reconciliationManifestSha !== ACCEPTED_RECONCILIATION_MANIFEST_SHA256) {
    errors.push(`Reconciliation manifest hash does not match accepted decision`);
  }

  const legacyDb = openReadonlyDatabase(options.legacySourcePath);
  let sourceIds: Set<string>;
  try {
    const legacyQuick = legacyDb.query("PRAGMA quick_check").all() as Array<{
      quick_check: string;
    }>;
    if (legacyQuick.length !== 1 || legacyQuick[0]?.quick_check !== "ok") {
      errors.push(`Legacy source quick_check failed`);
    }
    sourceIds = new Set(
      (legacyDb.query("SELECT id FROM notes WHERE deleted_at IS NULL").all() as
        Array<{ id: string }>).map((row) => row.id),
    );
  } finally {
    legacyDb.close();
  }
  if (sourceIds.size !== options.expectLegacyActive) {
    errors.push(
      `Legacy active denominator ${sourceIds.size} does not match expected ${options.expectLegacyActive}`,
    );
  }

  const targetRows = options.db
    .query(
      `SELECT id, metadata
       FROM notes
       WHERE deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; metadata: string }>;
  const direct = new Set(targetRows.map((row) => row.id));
  const mapped = new Map<string, string[]>();
  for (const row of targetRows) {
    try {
      const metadata = JSON.parse(row.metadata) as unknown;
      if (!isPlainRecord(metadata)) continue;
      const legacyId = metadata.legacy_source_id;
      if (typeof legacyId !== "string" || legacyId.length === 0) continue;
      const ids = mapped.get(legacyId) ?? [];
      ids.push(row.id);
      mapped.set(legacyId, ids);
    } catch {
      // Invalid historical metadata cannot contribute legacy coverage.
    }
  }
  let directOnly = 0;
  let mappedOnly = 0;
  let both = 0;
  let covered = 0;
  for (const sourceId of sourceIds) {
    const hasDirect = direct.has(sourceId);
    const hasMapped = mapped.has(sourceId);
    if (hasDirect && hasMapped) both += 1;
    else if (hasDirect) directOnly += 1;
    else if (hasMapped) mappedOnly += 1;
    if (hasDirect || hasMapped) covered += 1;
  }
  const duplicateMappings = [...mapped.values()].filter((ids) => ids.length > 1).length;
  const reconciliation = parseReconciliationManifest(
    options.reconciliationManifestPath,
  );
  const sourceSeen = new Set<string>();
  const canonicalSeen = new Set<string>();
  let reconciliationValid = 0;
  for (const row of reconciliation) {
    const targetIds = mapped.get(row.source_id) ?? [];
    const valid = row.status === "created" &&
      sourceIds.has(row.source_id) &&
      targetIds.includes(row.canonical_id) &&
      !sourceSeen.has(row.source_id) &&
      !canonicalSeen.has(row.canonical_id);
    if (valid) reconciliationValid += 1;
    sourceSeen.add(row.source_id);
    canonicalSeen.add(row.canonical_id);
  }
  if (covered !== options.expectLegacyActive) {
    errors.push(
      `Legacy coverage ${covered}/${options.expectLegacyActive}; missing ${options.expectLegacyActive - covered}`,
    );
  }
  if (reconciliationValid !== reconciliation.length) {
    errors.push(`Reconciliation manifest contains invalid or duplicate mappings`);
  }
  if (duplicateMappings > 0) errors.push(`Duplicate legacy_source_id mappings found`);

  const countTables = [
    "notes",
    "note_relations",
    "note_provenance",
    "memory_lifecycle",
    "extraction_runs",
    "extraction_candidates",
    "recall_traces",
    "recall_trace_items",
    "recall_feedback",
    "memory_event_outbox",
  ];
  const counts: Record<string, number> = {};
  for (const table of countTables) {
    counts[table] = (options.db.query(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
      count: number;
    }).count;
  }

  const requiredTables = countTables.length - 1;
  return {
    ok: errors.length === 0,
    schema: {
      actual: actualSchema,
      expected: options.expectSchema,
      versions,
      required_tables: requiredTables,
    },
    integrity: {
      quick_check: quickCheck,
      integrity_check: integrityCheck,
      foreign_key_violations: foreignKeyViolations,
      cross_workspace_violations: crossWorkspaceViolations,
    },
    relations: {
      total: relationGraph.total,
      cycles: relationGraph.cycles,
      multiple_head_components: relationGraph.multipleHeadComponents,
    },
    counts,
    legacy: {
      expected_active: options.expectLegacyActive,
      source_active: sourceIds.size,
      direct: directOnly,
      mapped: mappedOnly,
      both,
      covered,
      missing: options.expectLegacyActive - covered,
      duplicate_mappings: duplicateMappings,
      reconciliation_rows: reconciliation.length,
      reconciliation_valid: reconciliationValid,
      source_sha256: legacySourceSha,
      value_free_manifest_sha256: valueFreeManifestSha,
      reconciliation_manifest_sha256: reconciliationManifestSha,
    },
    hashes: {
      database_file_sha256: sha256File(options.dbPath),
      database_logical_sha256: computeLogicalDatabaseHash(options.db),
    },
    errors,
  };
}
