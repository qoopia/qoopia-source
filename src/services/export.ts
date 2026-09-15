import { assetPath } from "../utils/assets.ts";
import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import type { Database } from "bun:sqlite";
import { ensureSafeDir, ensureSafeFile } from "../utils/fs-perms.ts";
import { QoopiaError } from "../utils/errors.ts";
import { detectSecretLabels } from "../utils/secret-guard.ts";
import { recordConflict, v4Metrics } from "../utils/observability.ts";

export const EXPORT_FORMAT = "qoopia-v4-export/1" as const;
export const EXPORT_SCHEMA_VERSION = 32 as const;
const PLAN_TTL_MS = 15 * 60 * 1_000;
const PLAN_CACHE_MAX = 256;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const TABLE_FILE_MAX_BYTES = 1024 * 1024 * 1024;
const POLICY_PATH = assetPath("docs/v4/export-table-policy.json");
const SCHEMA_COLUMNS_PATH = assetPath("docs/v4/export-schema-columns.json");
const SAFE_ARTIFACT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const SENSITIVE_JSON_KEY = /(?:^|_)(?:authorization|cookie|password|secret|token|api_key|private_key)(?:$|_)/i;

type PolicyValue = "required" | "optional_ephemeral" | "derived" | "forbidden" | "manifest_only" | "local_config";
interface OrderColumn { column: string; type: "text" | "integer" }
interface TablePolicy {
  ordinal: number;
  name: string;
  policy: PolicyValue;
  order_by: OrderColumn[];
  projection: string | string[];
  projection_id?: string;
  omitted_columns?: string[];
  guard?: string;
  reason?: string;
}
interface PolicyDocument { schema_version: number; database_schema_version: number; logical_table_count: number; tables: TablePolicy[] }

export interface ExportSigner {
  private_key: string | Buffer | KeyObject;
}

export interface ExportPlan {
  format: typeof EXPORT_FORMAT;
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  counts: Record<string, number>;
  policies: Record<string, PolicyValue>;
  estimated_bytes: number;
  plan_hash: string;
  expires_at: string;
}

interface InternalPlan extends ExportPlan {
  workspace_id: string;
  actor_id: string;
  include_ephemeral: boolean;
  policy_sha256: string;
  release_sha: string;
  signature_key_id: string;
  data_version: number;
}

export interface ExportBundleResult {
  artifact_id: string;
  format: typeof EXPORT_FORMAT;
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  manifest_sha256: string;
  archive_sha256: string;
  signature_key_id: string;
  created_at: string;
  output_dir: string;
  archive_path: string;
}

export interface ImportConflict {
  table: string;
  row_id: string;
  code: "ROW_HASH_MISMATCH" | "WORKSPACE_MISMATCH" | "IDENTITY_MAPPING_REQUIRED" | "MISSING_REFERENCE" | "UNSUPPORTED_SCHEMA" | "UNSUPPORTED_FORMAT";
  source_hash: string | null;
  target_hash: string | null;
}

export interface ImportPlanResult {
  artifact_id: string;
  format: typeof EXPORT_FORMAT;
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  signature_key_id: string;
  valid: boolean;
  noops: number;
  inserts: number;
  conflicts: ImportConflict[];
  missing_references: string[];
  apply_allowed: false;
}

interface ManifestTable {
  ordinal: number;
  name: string;
  policy: PolicyValue;
  projection_id: string;
  order_key: OrderColumn[];
  path: string | null;
  sha256: string | null;
  row_count: number;
  byte_count: number;
}

interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  workspace_id: string;
  source_instance_id: string;
  release_sha: string;
  created_at: string;
  include_ephemeral: boolean;
  plan_hash: string;
  policy_sha256: string;
  schema_ledger: Array<Record<string, unknown>>;
  signature: { algorithm: "Ed25519"; digest: "SHA-256"; signature_key_id: string };
  tables: ManifestTable[];
}

const planCache = new Map<string, InternalPlan>();

function cachePlan(plan: InternalPlan, now: Date): void {
  for (const [hash, cached] of planCache) {
    if (new Date(cached.expires_at).getTime() < now.getTime()) planCache.delete(hash);
  }
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value as string | undefined;
    if (oldest) planCache.delete(oldest);
  }
  planCache.set(plan.plan_hash, plan);
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { $binary: Buffer.from(value).toString("base64"), encoding: "base64" };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new QoopiaError("INVALID_INPUT", "non-finite number cannot be exported");
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function loadPolicy(): { document: PolicyDocument; raw: string; sha: string } {
  const raw = fs.readFileSync(POLICY_PATH, "utf8");
  const document = JSON.parse(raw) as PolicyDocument;
  if (document.database_schema_version !== EXPORT_SCHEMA_VERSION ||
      document.logical_table_count !== document.tables.length || document.tables.length !== 40) {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "export policy does not describe schema 32 exactly");
  }
  const names = new Set(document.tables.map((table) => table.name));
  if (names.size !== document.tables.length) throw new QoopiaError("UNSUPPORTED_SCHEMA", "duplicate export table policy");
  return { document, raw, sha: sha256(raw) };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function logicalTables(database: Database): string[] {
  return (database.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string }>).map(({ name }) => name);
}

function assertLegacyTransferSchema(database: Database): void {
  const schema = database.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_versions").get() as { version: number };
  if (schema.version !== EXPORT_SCHEMA_VERSION) {
    throw new QoopiaError(
      "UNSUPPORTED_SCHEMA",
      `legacy schema 32 workspace transfer is unavailable for schema ${schema.version}; use installation backup plus restoreNew for a complete installation data copy`,
    );
  }
}

function assertSchema(database: Database, policy: PolicyDocument): void {
  assertLegacyTransferSchema(database);
  const declared = new Set(policy.tables.map((table) => table.name));
  const columnContract = JSON.parse(fs.readFileSync(SCHEMA_COLUMNS_PATH, "utf8")) as {
    schema_version: number;
    tables: Record<string, string[]>;
  };
  if (columnContract.schema_version !== EXPORT_SCHEMA_VERSION ||
      Object.keys(columnContract.tables).length !== policy.tables.length) {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "export column contract is incomplete");
  }
  const derivedFts = policy.tables.filter((table) => table.policy === "derived" && table.name.endsWith("_fts"));
  for (const table of logicalTables(database)) {
    if (declared.has(table)) continue;
    if (derivedFts.some((base) => table.startsWith(`${base.name}_`))) continue;
    throw new QoopiaError("UNSUPPORTED_SCHEMA", `unknown logical table blocks export: ${table}`);
  }
  for (const table of declared) {
    if (!logicalTables(database).includes(table)) {
      throw new QoopiaError("UNSUPPORTED_SCHEMA", `required schema table is missing: ${table}`);
    }
    const actual = (database.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map(({ name }) => name);
    const expected = columnContract.tables[table];
    if (!expected || canonicalJson(actual) !== canonicalJson(expected)) {
      throw new QoopiaError("UNSUPPORTED_SCHEMA", `unknown or missing columns block export: ${table}`);
    }
  }
}

function privateKey(signer: ExportSigner): KeyObject {
  return signer.private_key instanceof Object && "type" in signer.private_key
    ? signer.private_key as KeyObject
    : createPrivateKey(signer.private_key);
}

function signerIdentity(signer: ExportSigner): { privateKey: KeyObject; publicKey: KeyObject; keyId: string } {
  const key = privateKey(signer);
  const publicKey = createPublicKey(key);
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(der).subarray(-32);
  if (raw.length !== 32) throw new QoopiaError("INVALID_INPUT", "invalid Ed25519 public key");
  return { privateKey: key, publicKey, keyId: sha256(raw) };
}

function assertJsonMetadata(value: unknown, label: string, bodyKeys = false, depth = 0): void {
  if (depth > 10) throw new QoopiaError("SIZE_LIMIT", `${label} JSON nesting exceeds limit`);
  if (typeof value === "string") {
    if (detectSecretLabels(value).length > 0) throw new QoopiaError("INVALID_INPUT", `${label} contains a secret pattern`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item) => assertJsonMetadata(item, label, bodyKeys, depth + 1));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_JSON_KEY.test(key) || (bodyKeys && /(?:^|_)(?:body|content|text|query)(?:$|_)/i.test(key))) {
        throw new QoopiaError("INVALID_INPUT", `${label} contains forbidden metadata key ${key}`);
      }
      assertJsonMetadata(child, label, bodyKeys, depth + 1);
    }
  }
}

function projectRow(table: TablePolicy, raw: Record<string, unknown>, includeEphemeral: boolean): Record<string, unknown> {
  let row: Record<string, unknown>;
  if (Array.isArray(table.projection)) {
    row = Object.fromEntries(table.projection.map((column) => [column, raw[column]]));
  } else {
    row = { ...raw };
    for (const omitted of table.omitted_columns ?? []) delete row[omitted];
  }
  if (table.name === "recall_feedback" && !includeEphemeral) row.trace_id = null;
  for (const column of ["settings", "metadata", "details", "options", "payload"]) {
    if (typeof row[column] !== "string") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row[column] as string); }
    catch { throw new QoopiaError("INVALID_INPUT", `${table.name}.${column} is invalid JSON`); }
    const bodyKeys = table.name === "memory_event_outbox" || table.name === "agent_wake_events" ||
      (table.name === "workspaces" && column === "settings") ||
      (table.name === "agents" && column === "metadata");
    assertJsonMetadata(parsed, `${table.name}.${column}`, bodyKeys);
  }
  return canonicalValue(row) as Record<string, unknown>;
}

function queryRows(database: Database, table: TablePolicy, workspaceId: string): Array<Record<string, unknown>> {
  const q = quoteIdentifier(table.name);
  const columns = database.query(`PRAGMA table_info(${q})`).all() as Array<{ name: string }>;
  const hasWorkspace = columns.some(({ name }) => name === "workspace_id");
  const order = table.order_by.map(({ column, type }) => `${quoteIdentifier(column)} COLLATE BINARY ${type === "text" ? "" : ""}ASC`).join(", ");
  if (table.name === "workspaces") return database.query(`SELECT * FROM ${q} WHERE id = ?${order ? ` ORDER BY ${order}` : ""}`).all(workspaceId) as Array<Record<string, unknown>>;
  if (table.name === "entity_links") {
    return database.query(
      `SELECT l.* FROM entity_links l
       JOIN entity_pages s ON s.id = l.source_entity_id AND s.workspace_id = ?
       JOIN entity_pages t ON t.id = l.target_entity_id AND t.workspace_id = ?
       ORDER BY l.id ASC`,
    ).all(workspaceId, workspaceId) as Array<Record<string, unknown>>;
  }
  if (table.name === "wake_slo_probes") {
    return database.query(
      `SELECT p.* FROM wake_slo_probes p JOIN agent_comm_sessions s ON s.id = p.session_id
       WHERE s.workspace_id = ? ORDER BY p.probe_id ASC`,
    ).all(workspaceId) as Array<Record<string, unknown>>;
  }
  if (!hasWorkspace) {
    const count = (database.query(`SELECT COUNT(*) AS count FROM ${q}`).get() as { count: number }).count;
    if (count > 0) throw new QoopiaError("UNSUPPORTED_SCHEMA", `${table.name} has unscoped rows that cannot be exported safely`);
    return [];
  }
  return database.query(`SELECT * FROM ${q} WHERE workspace_id = ?${order ? ` ORDER BY ${order}` : ""}`).all(workspaceId) as Array<Record<string, unknown>>;
}

function tableIncluded(table: TablePolicy, includeEphemeral: boolean): boolean {
  return table.policy === "required" || (table.policy === "optional_ephemeral" && includeEphemeral);
}

function snapshotDataVersion(database: Database): number {
  return (database.query("PRAGMA data_version").get() as { data_version: number }).data_version;
}

function planPreimage(plan: Omit<InternalPlan, keyof ExportPlan | "plan_hash" | "expires_at"> & {
  counts: Record<string, number>; policies: Record<string, PolicyValue>; estimated_bytes: number;
}): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    schema_version: EXPORT_SCHEMA_VERSION,
    workspace_id: plan.workspace_id,
    actor_id: plan.actor_id,
    include_ephemeral: plan.include_ephemeral,
    policy_sha256: plan.policy_sha256,
    release_sha: plan.release_sha,
    signature_key_id: plan.signature_key_id,
    data_version: plan.data_version,
    counts: plan.counts,
    policies: plan.policies,
    estimated_bytes: plan.estimated_bytes,
  };
}

export function createExportPlan(input: {
  workspace_id: string;
  actor_id: string;
  include_ephemeral?: boolean;
  release_sha: string;
  signer: ExportSigner;
  database: Database;
  authorize?: () => void;
  now?: Date;
}): ExportPlan {
  const database = input.database;
  assertLegacyTransferSchema(database);
  const policy = loadPolicy();
  const identity = signerIdentity(input.signer);
  assertSchema(database, policy.document);
  const includeEphemeral = input.include_ephemeral === true;
  const counts: Record<string, number> = {};
  const policies: Record<string, PolicyValue> = {};
  let estimatedBytes = 0;
  database.exec("BEGIN DEFERRED");
  try {
    input.authorize?.();
    for (const table of policy.document.tables) {
      policies[table.name] = table.policy;
      if (!tableIncluded(table, includeEphemeral)) { counts[table.name] = 0; continue; }
      const rows = queryRows(database, table, input.workspace_id).map((row) => projectRow(table, row, includeEphemeral));
      counts[table.name] = rows.length;
      estimatedBytes += rows.reduce((sum, row) => sum + Buffer.byteLength(canonicalJson(row)) + 1, 0);
    }
    const base = {
      workspace_id: input.workspace_id,
      actor_id: input.actor_id,
      include_ephemeral: includeEphemeral,
      policy_sha256: policy.sha,
      release_sha: input.release_sha,
      signature_key_id: identity.keyId,
      data_version: snapshotDataVersion(database),
      counts,
      policies,
      estimated_bytes: estimatedBytes,
    };
    const planHash = sha256(canonicalJson(planPreimage(base)));
    const expiresAt = new Date((input.now ?? new Date()).getTime() + PLAN_TTL_MS).toISOString();
    const internal: InternalPlan = {
      ...base,
      format: EXPORT_FORMAT,
      schema_version: EXPORT_SCHEMA_VERSION,
      plan_hash: planHash,
      expires_at: expiresAt,
    };
    cachePlan(internal, input.now ?? new Date());
    database.exec("COMMIT");
    v4Metrics.observe("v4_export_plan_rows", Object.values(counts).reduce((a, b) => a + b, 0), { include_ephemeral: String(includeEphemeral) });
    return { format: internal.format, schema_version: internal.schema_version, counts, policies, estimated_bytes: estimatedBytes, plan_hash: planHash, expires_at: expiresAt };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function writeSafe(filename: string, content: string | Uint8Array): void {
  fs.writeFileSync(filename, content, { mode: 0o600 });
  ensureSafeFile(filename);
}

function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  return Buffer.from(text, "ascii");
}

function tarHeader(name: string, size: number, mode: number, type: "0" | "5"): Buffer {
  if (!name || Buffer.byteLength(name) > 100 || name.startsWith("/") || name.includes("..")) {
    throw new QoopiaError("INVALID_INPUT", `unsafe ustar entry: ${name}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  octal(mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  Buffer.from("        ").copy(header, 148);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  return header;
}

function writeDeterministicTar(root: string, output: string): void {
  const entries: Array<{ name: string; data: Buffer | null }> = [{ name: "data/", data: null }];
  for (const filename of ["manifest.json", "manifest.sig"]) {
    entries.push({ name: filename, data: fs.readFileSync(path.join(root, filename)) });
  }
  for (const filename of fs.readdirSync(path.join(root, "data")).sort()) {
    entries.push({ name: `data/${filename}`, data: fs.readFileSync(path.join(root, "data", filename)) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.name, entry.data?.length ?? 0, entry.data ? 0o600 : 0o700, entry.data ? "0" : "5"));
    if (entry.data) {
      chunks.push(entry.data);
      const padding = (512 - (entry.data.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1_024));
  writeSafe(output, Buffer.concat(chunks));
}

function readExistingBundle(input: {
  outputDir: string;
  artifactId: string;
  identity: ReturnType<typeof signerIdentity>;
  cached: InternalPlan;
  sourceInstanceId: string;
  policy: ReturnType<typeof loadPolicy>;
}): ExportBundleResult {
  const stat = fs.lstatSync(input.outputDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new QoopiaError("CONFLICT", "existing export artifact is not a safe directory");
  }
  const manifestText = readRegularFile(
    path.join(input.outputDir, "manifest.json"), input.outputDir, MANIFEST_MAX_BYTES,
  ).toString("utf8");
  const manifest = JSON.parse(manifestText) as ExportManifest;
  if (canonicalJson(manifest) !== manifestText || manifest.format !== EXPORT_FORMAT ||
      manifest.schema_version !== EXPORT_SCHEMA_VERSION || manifest.workspace_id !== input.cached.workspace_id ||
      manifest.release_sha !== input.cached.release_sha || manifest.plan_hash !== input.cached.plan_hash ||
      manifest.source_instance_id !== input.sourceInstanceId || manifest.policy_sha256 !== input.policy.sha ||
      manifest.signature.signature_key_id !== input.identity.keyId) {
    throw new QoopiaError("CONFLICT", "existing export artifact does not match the idempotent request");
  }
  assertManifestContract(manifest, input.policy.document);
  const signature = Buffer.from(readRegularFile(
    path.join(input.outputDir, "manifest.sig"), input.outputDir, 1024,
  ).toString("utf8").trim(), "base64url");
  const digest = createHash("sha256").update(manifestText).digest();
  if (!verifyBytes(null, digest, input.identity.publicKey, signature)) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "existing export artifact signature is invalid");
  }
  assertBundleEntries(input.outputDir, manifest);
  for (const table of manifest.tables) {
    if (!table.path) continue;
    const content = readRegularFile(path.join(input.outputDir, table.path), input.outputDir, TABLE_FILE_MAX_BYTES);
    if (content.byteLength !== table.byte_count || sha256(content) !== table.sha256) {
      throw new QoopiaError("CHECKSUM_MISMATCH", `existing export table checksum mismatch: ${table.name}`);
    }
  }
  const archivePath = `${input.outputDir}.tar`;
  const archiveStat = fs.lstatSync(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || (archiveStat.mode & 0o077) !== 0) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "existing export archive is missing or unsafe");
  }
  return {
    artifact_id: input.artifactId,
    format: EXPORT_FORMAT,
    schema_version: EXPORT_SCHEMA_VERSION,
    manifest_sha256: digest.toString("hex"),
    archive_sha256: sha256(fs.readFileSync(archivePath)),
    signature_key_id: input.identity.keyId,
    created_at: manifest.created_at,
    output_dir: input.outputDir,
    archive_path: archivePath,
  };
}

export function materializeExportBundle(input: {
  plan_hash: string;
  idempotency_key: string;
  workspace_id: string;
  actor_id: string;
  release_sha: string;
  source_instance_id: string;
  signer: ExportSigner;
  export_root: string;
  output_dir?: string;
  database: Database;
  authorize?: () => void;
  now?: Date;
}): ExportBundleResult {
  const database = input.database;
  const cached = planCache.get(input.plan_hash);
  if (!cached || cached.workspace_id !== input.workspace_id || cached.actor_id !== input.actor_id || cached.release_sha !== input.release_sha) {
    throw new QoopiaError("CONFLICT", "export plan is missing or bound to another caller/release");
  }
  const now = input.now ?? new Date();
  if (now.getTime() > new Date(cached.expires_at).getTime()) throw new QoopiaError("CONFLICT", "export plan expired");
  const policy = loadPolicy();
  const identity = signerIdentity(input.signer);
  if (identity.keyId !== cached.signature_key_id || policy.sha !== cached.policy_sha256) {
    throw new QoopiaError("CONFLICT", "export policy or signing identity changed since plan");
  }
  const artifactId = `v4-${sha256(`${input.workspace_id}\n${input.idempotency_key}`).slice(0, 32)}`;
  if (!SAFE_ARTIFACT.test(artifactId)) throw new QoopiaError("INVALID_INPUT", "invalid export artifact ID");
  ensureSafeDir(input.export_root);
  const outputDir = path.resolve(input.output_dir ?? path.join(input.export_root, artifactId));
  const rootResolved = path.resolve(input.export_root);
  if (outputDir !== rootResolved && !outputDir.startsWith(`${rootResolved}${path.sep}`)) {
    throw new QoopiaError("FORBIDDEN", "export output escapes sanctioned root");
  }
  if (fs.existsSync(outputDir)) {
    database.transaction(() => input.authorize?.())();
    const replay = readExistingBundle({
      outputDir,
      artifactId,
      identity,
      cached,
      sourceInstanceId: input.source_instance_id,
      policy,
    });
    v4Metrics.increment("v4_export_bundle_total", { result: "idempotent" });
    return replay;
  }
  if (fs.existsSync(`${outputDir}.tar`)) {
    throw new QoopiaError("CONFLICT", "orphaned export archive blocks artifact creation");
  }
  ensureSafeDir(outputDir);
  ensureSafeDir(path.join(outputDir, "data"));
  const tables: ManifestTable[] = [];
  let rederivedCounts: Record<string, number> = {};
  let rederivedBytes = 0;
  database.exec("BEGIN DEFERRED");
  try {
    input.authorize?.();
    assertSchema(database, policy.document);
    if (snapshotDataVersion(database) !== cached.data_version) throw new QoopiaError("CONFLICT", "database changed since export plan");
    for (const table of policy.document.tables) {
      if (!tableIncluded(table, cached.include_ephemeral)) {
        tables.push({ ordinal: table.ordinal, name: table.name, policy: table.policy, projection_id: table.projection_id ?? "none", order_key: table.order_by, path: null, sha256: null, row_count: 0, byte_count: 0 });
        rederivedCounts[table.name] = 0;
        continue;
      }
      const rows = queryRows(database, table, input.workspace_id).map((row) => projectRow(table, row, cached.include_ephemeral));
      const content = rows.map((row) => `${canonicalJson(row)}\n`).join("");
      const relative = `data/${String(table.ordinal).padStart(3, "0")}-${table.name}.ndjson`;
      writeSafe(path.join(outputDir, relative), content);
      const bytes = Buffer.byteLength(content);
      rederivedCounts[table.name] = rows.length;
      rederivedBytes += bytes;
      tables.push({ ordinal: table.ordinal, name: table.name, policy: table.policy, projection_id: table.projection_id ?? "identity_v1", order_key: table.order_by, path: relative, sha256: sha256(content), row_count: rows.length, byte_count: bytes });
    }
    const rederivedBase = {
      workspace_id: input.workspace_id, actor_id: input.actor_id,
      include_ephemeral: cached.include_ephemeral, policy_sha256: policy.sha,
      release_sha: input.release_sha, signature_key_id: identity.keyId,
      data_version: snapshotDataVersion(database), counts: rederivedCounts,
      policies: cached.policies, estimated_bytes: rederivedBytes,
    };
    if (sha256(canonicalJson(planPreimage(rederivedBase))) !== input.plan_hash) {
      throw new QoopiaError("CONFLICT", "export plan no longer matches the read snapshot");
    }
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      schema_version: EXPORT_SCHEMA_VERSION,
      workspace_id: input.workspace_id,
      source_instance_id: input.source_instance_id,
      release_sha: input.release_sha,
      created_at: now.toISOString(),
      include_ephemeral: cached.include_ephemeral,
      plan_hash: input.plan_hash,
      policy_sha256: policy.sha,
      schema_ledger: database.query("SELECT version, description, applied_at FROM schema_versions ORDER BY version ASC").all() as Array<Record<string, unknown>>,
      signature: { algorithm: "Ed25519", digest: "SHA-256", signature_key_id: identity.keyId },
      tables,
    };
    const manifestText = canonicalJson(manifest);
    const manifestDigest = createHash("sha256").update(manifestText).digest();
    const signature = signBytes(null, manifestDigest, identity.privateKey).toString("base64url");
    writeSafe(path.join(outputDir, "manifest.json"), manifestText);
    writeSafe(path.join(outputDir, "manifest.sig"), signature);
    const archivePath = `${outputDir}.tar`;
    writeDeterministicTar(outputDir, archivePath);
    database.exec("COMMIT");
    v4Metrics.increment("v4_export_bundle_total", { result: "success" });
    return {
      artifact_id: artifactId,
      format: EXPORT_FORMAT,
      schema_version: EXPORT_SCHEMA_VERSION,
      manifest_sha256: manifestDigest.toString("hex"),
      archive_sha256: sha256(fs.readFileSync(archivePath)),
      signature_key_id: identity.keyId,
      created_at: manifest.created_at,
      output_dir: outputDir,
      archive_path: archivePath,
    };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(`${outputDir}.tar`, { force: true }); } catch {}
    v4Metrics.increment("v4_export_bundle_total", { result: "failed" });
    throw error;
  }
}

function trustedPublicKey(value: string | Buffer | KeyObject): KeyObject {
  if (value instanceof Object && "type" in value) return value as KeyObject;
  if (typeof value === "string" && fs.existsSync(value)) return createPublicKey(fs.readFileSync(value));
  return createPublicKey(value);
}

function publicKeyId(key: KeyObject): string {
  const der = Buffer.from(key.export({ format: "der", type: "spki" }));
  const raw = der.subarray(-32);
  if (raw.length !== 32) throw new QoopiaError("UNTRUSTED_SIGNING_KEY", "trusted key is not Ed25519");
  return sha256(raw);
}

function readRegularFile(filename: string, root: string, maxBytes: number): Buffer {
  const rootReal = fs.realpathSync(root);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new QoopiaError("CHECKSUM_MISMATCH", `unsafe or oversized bundle file: ${path.basename(filename)}`);
  }
  const real = fs.realpathSync(filename);
  if (!real.startsWith(`${rootReal}${path.sep}`)) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "bundle file escapes the artifact root");
  }
  return fs.readFileSync(real);
}

function expectedProjectionColumns(table: TablePolicy): string[] {
  if (Array.isArray(table.projection)) return [...table.projection].sort();
  const contract = JSON.parse(fs.readFileSync(SCHEMA_COLUMNS_PATH, "utf8")) as {
    tables: Record<string, string[]>;
  };
  return (contract.tables[table.name] ?? [])
    .filter((column) => !(table.omitted_columns ?? []).includes(column))
    .sort();
}

function assertManifestContract(manifest: ExportManifest, policy: PolicyDocument): void {
  if (typeof manifest.include_ephemeral !== "boolean" ||
      manifest.signature?.algorithm !== "Ed25519" || manifest.signature?.digest !== "SHA-256") {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "manifest signature or ephemeral contract is invalid");
  }
  if (manifest.tables.length !== policy.tables.length) {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "manifest table contract is incomplete");
  }
  for (let index = 0; index < policy.tables.length; index++) {
    const actual = manifest.tables[index]!;
    const expected = policy.tables[index]!;
    const included = tableIncluded(expected, manifest.include_ephemeral);
    const expectedPath = included
      ? `data/${String(expected.ordinal).padStart(3, "0")}-${expected.name}.ndjson`
      : null;
    const projectionId = expected.projection_id ?? (included ? "identity_v1" : "none");
    if (actual.name !== expected.name || actual.ordinal !== expected.ordinal || actual.policy !== expected.policy ||
        actual.projection_id !== projectionId || canonicalJson(actual.order_key) !== canonicalJson(expected.order_by) ||
        actual.path !== expectedPath) {
      throw new QoopiaError("UNSUPPORTED_SCHEMA", `manifest table contract drift at ordinal ${expected.ordinal}`);
    }
  }
  const versions = manifest.schema_ledger.map((row) => Number(row.version));
  if (!versions.length || versions.at(-1) !== EXPORT_SCHEMA_VERSION ||
      versions.some((version, index) => !Number.isSafeInteger(version) || version <= 0 || (index > 0 && version <= versions[index - 1]!))) {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "manifest schema ledger is invalid");
  }
}

function assertBundleEntries(bundle: string, manifest: ExportManifest): void {
  const rootEntries = fs.readdirSync(bundle).sort();
  if (canonicalJson(rootEntries) !== canonicalJson(["data", "manifest.json", "manifest.sig"])) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "bundle root contains missing or extra entries");
  }
  const dataDir = path.join(bundle, "data");
  const dataStat = fs.lstatSync(dataDir);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "bundle data entry must be a real directory");
  }
  const expected = manifest.tables
    .flatMap((table) => table.path ? [path.basename(table.path)] : [])
    .sort();
  if (canonicalJson(fs.readdirSync(dataDir).sort()) !== canonicalJson(expected)) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "bundle data directory contains missing or extra files");
  }
}

function rowId(table: ManifestTable, row: Record<string, unknown>): string {
  return table.order_key.map(({ column }) => String(row[column])).join("|");
}

function compareRows(table: ManifestTable, left: Record<string, unknown>, right: Record<string, unknown>): number {
  for (const { column, type } of table.order_key) {
    const a = left[column];
    const b = right[column];
    const comparison = type === "integer"
      ? Number(a) - Number(b)
      : Buffer.compare(Buffer.from(String(a), "utf8"), Buffer.from(String(b), "utf8"));
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function targetRow(database: Database, table: ManifestTable, row: Record<string, unknown>): Record<string, unknown> | null {
  if (!table.order_key.length) return null;
  const where = table.order_key.map(({ column }) => `${quoteIdentifier(column)} = ?`).join(" AND ");
  const bindings = table.order_key.map(({ column }) => row[column]) as Array<string | number | bigint | boolean | null>;
  return database.query(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${where}`)
    .get(...bindings) as Record<string, unknown> | null;
}

export function validateImportPlan(input: {
  bundle_dir: string;
  artifact_id: string;
  target_workspace_id: string;
  trust_store: Record<string, string | Buffer | KeyObject>;
  database: Database;
  authorize?: () => void;
}): ImportPlanResult {
  const database = input.database;
  assertLegacyTransferSchema(database);
  if (!SAFE_ARTIFACT.test(input.artifact_id)) throw new QoopiaError("INVALID_INPUT", "invalid artifact ID");
  const bundle = path.resolve(input.bundle_dir);
  const bundleStat = fs.lstatSync(bundle);
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "bundle root must be a real directory");
  }
  const manifestPath = path.join(bundle, "manifest.json");
  const signaturePath = path.join(bundle, "manifest.sig");
  const manifestText = readRegularFile(manifestPath, bundle, MANIFEST_MAX_BYTES).toString("utf8");
  const manifest = JSON.parse(manifestText) as ExportManifest;
  if (canonicalJson(manifest) !== manifestText) throw new QoopiaError("CHECKSUM_MISMATCH", "manifest is not canonical JSON");
  if (manifest.format !== EXPORT_FORMAT || manifest.schema_version !== EXPORT_SCHEMA_VERSION) {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "unsupported export format or schema");
  }
  if (manifest.workspace_id !== input.target_workspace_id) throw new QoopiaError("CONFLICT", "bundle workspace does not match import target");
  const policy = loadPolicy();
  if (manifest.policy_sha256 !== policy.sha) {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "bundle export policy is unknown");
  }
  assertManifestContract(manifest, policy.document);
  const trusted = input.trust_store[manifest.signature.signature_key_id];
  if (!trusted) throw new QoopiaError("UNTRUSTED_SIGNING_KEY", "export signing key is not trusted");
  const publicKey = trustedPublicKey(trusted);
  if (publicKey.asymmetricKeyType !== "ed25519" || publicKeyId(publicKey) !== manifest.signature.signature_key_id) {
    throw new QoopiaError("UNTRUSTED_SIGNING_KEY", "trusted key ID does not match the manifest");
  }
  const signature = Buffer.from(readRegularFile(signaturePath, bundle, 1024).toString("utf8").trim(), "base64url");
  const digest = createHash("sha256").update(manifestText).digest();
  if (!verifyBytes(null, digest, publicKey, signature)) throw new QoopiaError("CHECKSUM_MISMATCH", "manifest signature is invalid");
  assertBundleEntries(bundle, manifest);
  let noops = 0;
  let inserts = 0;
  const conflicts: ImportConflict[] = [];
  const missing = new Set<string>();
  const rowsByTable = new Map<string, Array<Record<string, unknown>>>();
  database.exec("BEGIN DEFERRED");
  try {
    input.authorize?.();
    assertSchema(database, policy.document);
    for (const table of manifest.tables) {
    const declared = policy.document.tables.find((item) => item.name === table.name);
    if (!declared || declared.ordinal !== table.ordinal || declared.policy !== table.policy) {
      throw new QoopiaError("UNSUPPORTED_SCHEMA", `manifest table policy drift: ${table.name}`);
    }
    if (!table.path) {
      if (table.sha256 !== null || table.row_count !== 0 || table.byte_count !== 0) throw new QoopiaError("CHECKSUM_MISMATCH", `omitted table has materialized metadata: ${table.name}`);
      continue;
    }
    if (!/^data\/[0-9]{3}-[a-z0-9_]+\.ndjson$/.test(table.path) || table.path.includes("..")) {
      throw new QoopiaError("CHECKSUM_MISMATCH", "unsafe manifest data path");
    }
    const filename = path.resolve(bundle, table.path);
    if (!filename.startsWith(`${bundle}${path.sep}`)) throw new QoopiaError("CHECKSUM_MISMATCH", "bundle path traversal refused");
    const content = readRegularFile(filename, bundle, TABLE_FILE_MAX_BYTES).toString("utf8");
    if (sha256(content) !== table.sha256 || Buffer.byteLength(content) !== table.byte_count) {
      throw new QoopiaError("CHECKSUM_MISMATCH", `table checksum mismatch: ${table.name}`);
    }
    const lines = content ? content.split("\n").slice(0, -1) : [];
    if (lines.length !== table.row_count || (content && !content.endsWith("\n"))) {
      throw new QoopiaError("CHECKSUM_MISMATCH", `table row count mismatch: ${table.name}`);
    }
    const rows = lines.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (canonicalJson(row) !== line) throw new QoopiaError("CHECKSUM_MISMATCH", `noncanonical row in ${table.name}`);
      const actualColumns = Object.keys(row).sort();
      if (canonicalJson(actualColumns) !== canonicalJson(expectedProjectionColumns(declared))) {
        throw new QoopiaError("UNSUPPORTED_SCHEMA", `row projection drift in ${table.name}`);
      }
      projectRow(declared, row, manifest.include_ephemeral);
      return row;
    });
    for (let index = 1; index < rows.length; index++) {
      if (compareRows(table, rows[index - 1]!, rows[index]!) >= 0) throw new QoopiaError("CHECKSUM_MISMATCH", `row order violation in ${table.name}`);
    }
    rowsByTable.set(table.name, rows);
    for (const row of rows) {
      if ("workspace_id" in row && row.workspace_id !== input.target_workspace_id) {
        conflicts.push({ table: table.name, row_id: rowId(table, row), code: "WORKSPACE_MISMATCH", source_hash: sha256(canonicalJson(row)), target_hash: null });
        continue;
      }
      if (table.name === "workspaces" && row.id !== input.target_workspace_id) {
        conflicts.push({ table: table.name, row_id: rowId(table, row), code: "WORKSPACE_MISMATCH", source_hash: sha256(canonicalJson(row)), target_hash: null });
        continue;
      }
      const target = targetRow(database, table, row);
      if (!target) { inserts += 1; continue; }
      const projected = projectRow(declared, target, manifest.include_ephemeral);
      const sourceHash = sha256(canonicalJson(row));
      const targetHash = sha256(canonicalJson(projected));
      if (sourceHash === targetHash) noops += 1;
      else conflicts.push({
        table: table.name,
        row_id: rowId(table, row),
        code: table.name === "agents" || table.name === "users" ? "IDENTITY_MAPPING_REQUIRED" : "ROW_HASH_MISMATCH",
        source_hash: sourceHash,
        target_hash: targetHash,
      });
    }
  }
  const notes = new Set((rowsByTable.get("notes") ?? []).map((row) => String(row.id)));
  const agents = new Set((rowsByTable.get("agents") ?? []).map((row) => String(row.id)));
  const runs = new Set((rowsByTable.get("extraction_runs") ?? []).map((row) => String(row.id)));
  const traces = new Set((rowsByTable.get("recall_traces") ?? []).map((row) => String(row.id)));
  const messages = new Set((rowsByTable.get("agent_comm_messages") ?? []).map((row) => String(row.id)));
  const entities = new Set((rowsByTable.get("entity_pages") ?? []).map((row) => String(row.id)));
  const requireRef = (table: string, id: unknown, set: Set<string>) => {
    if (id !== null && id !== undefined && !set.has(String(id))) missing.add(`${table}:${String(id)}`);
  };
  for (const row of rowsByTable.get("note_relations") ?? []) { requireRef("notes", row.source_note_id, notes); requireRef("notes", row.target_note_id, notes); }
  for (const row of rowsByTable.get("note_provenance") ?? []) requireRef("notes", row.note_id, notes);
  for (const row of rowsByTable.get("memory_lifecycle") ?? []) requireRef("notes", row.note_id, notes);
  for (const row of rowsByTable.get("extraction_candidates") ?? []) requireRef("extraction_runs", row.run_id, runs);
  for (const row of rowsByTable.get("recall_feedback") ?? []) { requireRef("notes", row.note_id, notes); requireRef("recall_traces", row.trace_id, traces); requireRef("agents", row.actor_agent_id, agents); }
  for (const row of rowsByTable.get("entity_links") ?? []) { requireRef("entity_pages", row.source_entity_id, entities); requireRef("entity_pages", row.target_entity_id, entities); }
  for (const ref of missing) conflicts.push({ table: ref.split(":", 1)[0]!, row_id: ref, code: "MISSING_REFERENCE", source_hash: null, target_hash: null });
  database.exec("COMMIT");
  if (conflicts.length > 0) recordConflict("import");
  v4Metrics.increment("v4_import_plan_total", { result: conflicts.length ? "conflict" : "valid" });
  return {
    artifact_id: input.artifact_id,
    format: EXPORT_FORMAT,
    schema_version: EXPORT_SCHEMA_VERSION,
    signature_key_id: manifest.signature.signature_key_id,
    valid: conflicts.length === 0,
    noops,
    inserts,
    conflicts,
    missing_references: [...missing].sort(),
    apply_allowed: false,
  };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    v4Metrics.increment("v4_import_plan_total", { result: "failed" });
    throw error;
  }
}

export function clearExportPlanCacheForTests(): void {
  planCache.clear();
}
