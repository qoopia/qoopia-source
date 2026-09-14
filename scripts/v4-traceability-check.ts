import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

const ROOT = path.resolve(import.meta.dir, "..");
const docsArg = process.argv[2] ?? "docs/v4";
const DOCS = path.resolve(ROOT, docsArg);
const DECISIONS = path.join(ROOT, "docs/decisions");

const REQUIRED_DOCS = [
  "README.md",
  "architecture.md",
  "schema-contract.md",
  "tool-contract.md",
  "tool-contract.json",
  "feature-flags.md",
  "lifecycle-policy.md",
  "recall-ranking.md",
  "api-compatibility.md",
  "threat-model.md",
  "export-dr-contract.md",
  "rollout-dag.md",
  "ownership.md",
  "benchmark-protocol.json",
  "benchmark-corpus-spec.json",
  "performance-budgets.json",
  "export-table-policy.json",
  "traceability.json",
  "spec-reconciliation.md",
  "open-questions.md",
  "contracts/current-tools.json",
  "contracts/proposed-v4-tools.json",
  "contracts/v4-response-schemas.json",
  "contracts/v4-benchmark-case.schema.json",
];

function fail(message: string): never {
  throw new Error(message);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(absolute));
    else out.push(absolute);
  }
  return out.sort();
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function resolveJsonPointer(document: unknown, fragment: string): unknown {
  if (!fragment.startsWith("#/")) fail(`unsupported JSON pointer fragment: ${fragment}`);
  let current: unknown = document;
  for (const encoded of fragment.slice(2).split("/")) {
    const key = decodeURIComponent(encoded).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !(key in current)) {
      fail(`unresolved JSON pointer fragment: ${fragment}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

for (const relative of REQUIRED_DOCS) {
  const absolute = path.join(DOCS, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    fail(`required P01 document missing: ${relative}`);
  }
}

const adrNames = [
  "ADR-V4-0001-migration-coordinate-rebase.md",
  ...Array.from({ length: 10 }, (_, index) =>
    `ADR-V4-${String(index + 1).padStart(3, "0")}.md`,
  ),
];

for (const name of adrNames) {
  const absolute = path.join(DECISIONS, name);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    fail(`required P01 ADR missing: ${name}`);
  }
  const text = fs.readFileSync(absolute, "utf8");
  if (!/^Status: Accepted$/m.test(text)) fail(`ADR is not Accepted: ${name}`);
}

const checked = [...filesUnder(DOCS), ...adrNames.map((name) => path.join(DECISIONS, name))];
for (const file of checked) {
  const text = fs.readFileSync(file, "utf8");
  if (/\b(?:TBD|FIXME)\b/.test(text)) {
    fail(`unresolved marker in ${path.relative(ROOT, file)}`);
  }
  if (/schema\s+30\b/i.test(text)) {
    fail(`stale post-amendment schema coordinate in ${path.relative(ROOT, file)}`);
  }
  if (/note\/(?:create|list|get|update|delete)/.test(text)) {
    fail(`deprecated slash-form alias revived in ${path.relative(ROOT, file)}`);
  }
}

const markdown = checked.filter((file) => file.endsWith(".md"));
let localLinksChecked = 0;
for (const file of markdown) {
  const text = fs.readFileSync(file, "utf8");
  const links = text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const raw = match[1]!.trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z]+:/i.test(raw)) continue;
    const target = raw.split("#", 1)[0]!;
    if (!target) continue;
    localLinksChecked += 1;
    const absolute = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(absolute)) {
      fail(`broken local link ${raw} in ${path.relative(ROOT, file)}`);
    }
  }
}

for (const file of checked.filter((candidate) => candidate.endsWith(".json"))) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid JSON ${path.relative(ROOT, file)}: ${error}`);
  }
}

const traceability = JSON.parse(
  fs.readFileSync(path.join(DOCS, "traceability.json"), "utf8"),
) as { requirements?: Array<{ id?: string; evidence?: string[] }> };
const expectedRequirements = Array.from({ length: 25 }, (_, index) =>
  `R${String(index + 1).padStart(2, "0")}`,
);
const actualRequirements = (traceability.requirements ?? []).map((item) => item.id);
if (JSON.stringify(actualRequirements) !== JSON.stringify(expectedRequirements)) {
  fail("traceability.json must map R01 through R25 exactly once and in order");
}
for (const requirement of traceability.requirements ?? []) {
  if (!requirement.evidence?.length) fail(`${requirement.id} has no frozen evidence path`);
  for (const evidence of requirement.evidence) {
    const absolute = path.join(ROOT, evidence);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      fail(`${requirement.id} evidence path does not resolve: ${evidence}`);
    }
  }
}

const proposed = JSON.parse(
  fs.readFileSync(path.join(DOCS, "contracts/proposed-v4-tools.json"), "utf8"),
) as {
  schema_version?: number;
  migration_target?: number;
  additive_only?: boolean;
  canonical_tools?: Array<{
    name: string;
    risk?: string;
    result_schema?: { $ref?: string };
    authorization?: {
      oauth_scope_any?: string[];
      tool_profile_any?: string[];
      agent_type_any?: string[];
      instance_role_any?: string[];
      resource_rules?: string[];
      transaction_recheck?: boolean;
    };
  }>;
};
if (proposed.schema_version !== 2 || proposed.migration_target !== 32 || proposed.additive_only !== true) {
  fail("proposed tool snapshot is not pinned to additive schema 32");
}
const names = (proposed.canonical_tools ?? []).map((tool) => tool.name);
if (new Set(names).size !== names.length) fail("proposed tool snapshot contains duplicate names");

const delta = JSON.parse(fs.readFileSync(path.join(DOCS, "tool-contract.json"), "utf8")) as {
  response_schema_registry?: { id?: string; path?: string };
  authorization_contract?: { resource_rules?: Record<string, string> };
  new_tools?: Array<{ name: string }>;
};
const responseSchemaPath = path.join(ROOT, delta.response_schema_registry?.path ?? "");
const responseSchemas = JSON.parse(fs.readFileSync(responseSchemaPath, "utf8")) as {
  $id?: string;
};
if (!delta.response_schema_registry?.id || responseSchemas.$id !== delta.response_schema_registry.id) {
  fail("response schema registry ID/path mismatch");
}
const newToolNames = new Set((delta.new_tools ?? []).map((tool) => tool.name));
const allowedScopes = new Set(["mcp:read", "mcp:write", "mcp:admin"]);
const allowedProfiles = new Set(["read-only", "no-destructive", "full"]);
const allowedInstances = new Set(["canonical", "legacy-readonly"]);
const resourceRules = delta.authorization_contract?.resource_rules ?? {};
for (const tool of proposed.canonical_tools ?? []) {
  if (!newToolNames.has(tool.name)) continue;
  const ref = tool.result_schema?.$ref;
  const prefix = `${responseSchemas.$id}#`;
  if (!ref?.startsWith(prefix) || ref.includes(".md#")) {
    fail(`new tool '${tool.name}' result schema is not a resolvable JSON Schema registry ref`);
  }
  resolveJsonPointer(responseSchemas, `#${ref.slice(prefix.length)}`);
  const auth = tool.authorization;
  if (!auth?.oauth_scope_any?.length || !auth.tool_profile_any?.length ||
      !auth.agent_type_any?.length || !auth.instance_role_any?.length ||
      !auth.resource_rules?.length || typeof auth.transaction_recheck !== "boolean") {
    fail(`new tool '${tool.name}' has incomplete authorization contract`);
  }
  if (auth.oauth_scope_any.some((scope) => !allowedScopes.has(scope))) {
    fail(`new tool '${tool.name}' has unknown OAuth scope`);
  }
  if (auth.tool_profile_any.some((profile) => !allowedProfiles.has(profile))) {
    fail(`new tool '${tool.name}' has unknown tool profile`);
  }
  if (auth.instance_role_any.some((role) => !allowedInstances.has(role))) {
    fail(`new tool '${tool.name}' has unknown instance role`);
  }
  for (const rule of auth.resource_rules) {
    if (!(rule in resourceRules)) fail(`new tool '${tool.name}' references unknown auth rule '${rule}'`);
  }
}
for (const name of ["export_plan", "export_bundle", "import_plan"]) {
  const tool = proposed.canonical_tools?.find((candidate) => candidate.name === name);
  if (tool?.risk !== "admin" || JSON.stringify(tool.authorization?.oauth_scope_any) !== JSON.stringify(["mcp:admin"]) ||
      JSON.stringify(tool.authorization?.tool_profile_any) !== JSON.stringify(["full"]) ||
      JSON.stringify(tool.authorization?.agent_type_any) !== JSON.stringify(["owner", "steward"]) ||
      JSON.stringify(tool.authorization?.instance_role_any) !== JSON.stringify(["canonical"]) ||
      tool.authorization?.transaction_recheck !== true) {
    fail(`${name} does not match the frozen admin authorization contract`);
  }
}

const benchmark = JSON.parse(fs.readFileSync(path.join(DOCS, "benchmark-protocol.json"), "utf8")) as {
  schema_version?: number;
  corpus?: { spec_path?: string; spec_sha256?: string; case_schema_path?: string; case_schema_sha256?: string; recall_case_count?: number; splits?: Record<string, number> };
  primary_strata?: Record<string, number>;
};
if (benchmark.schema_version !== 2 || !benchmark.corpus?.spec_path || !benchmark.corpus.case_schema_path) {
  fail("benchmark protocol schema/corpus identity is incomplete");
}
const corpusSpecPath = path.join(ROOT, benchmark.corpus.spec_path);
const caseSchemaPath = path.join(ROOT, benchmark.corpus.case_schema_path);
if (sha256File(corpusSpecPath) !== benchmark.corpus.spec_sha256 ||
    sha256File(caseSchemaPath) !== benchmark.corpus.case_schema_sha256) {
  fail("benchmark corpus or case-schema identity hash drift");
}
const corpusSpec = JSON.parse(fs.readFileSync(corpusSpecPath, "utf8")) as {
  case_count?: number;
  split_rule?: { expected_counts?: Record<string, number> };
  strata?: Array<{
    name?: string;
    start?: number;
    end?: number;
    phrases?: string[];
    request?: unknown;
    labels?: unknown;
    variants?: Array<{
      selector?: { field?: string; operation?: string; modulus?: number; equals?: number };
      request?: unknown;
      labels?: unknown;
    }>;
  }>;
};
const caseSchema = JSON.parse(fs.readFileSync(caseSchemaPath, "utf8")) as { $id?: string };
if (caseSchema.$id !== "https://qoopia.local/contracts/v4-benchmark-case.schema.json") {
  fail("benchmark case schema ID drift");
}
const covered = new Set<number>();
const observedStrata: Record<string, number> = {};
for (const stratum of corpusSpec.strata ?? []) {
  if (!stratum.name || !stratum.start || !stratum.end || stratum.start > stratum.end) {
    fail("invalid benchmark stratum range");
  }
  observedStrata[stratum.name] = stratum.end - stratum.start + 1;
  if (!stratum.phrases?.length) fail(`benchmark stratum '${stratum.name}' has no phrase vocabulary`);
  if (stratum.variants?.length) {
    for (let localIndex = 1; localIndex <= stratum.end - stratum.start + 1; localIndex += 1) {
      const matches = stratum.variants.filter((variant) => {
        const selector = variant.selector;
        return selector?.field === "local_index" && selector.operation === "mod_equals" &&
          Number.isInteger(selector.modulus) && selector.modulus! > 0 &&
          Number.isInteger(selector.equals) && localIndex % selector.modulus! === selector.equals;
      });
      if (matches.length !== 1) {
        fail(`benchmark stratum '${stratum.name}' local index ${localIndex} does not resolve one machine variant`);
      }
      const selected = matches[0]!;
      if ((typeof selected.request !== "object" && typeof stratum.request !== "object") ||
          typeof selected.labels !== "object") {
        fail(`benchmark stratum '${stratum.name}' local index ${localIndex} lacks machine request/labels`);
      }
    }
  } else if (typeof stratum.request !== "object" || typeof stratum.labels !== "object") {
    fail(`benchmark stratum '${stratum.name}' lacks machine-readable request/labels`);
  }
  for (let index = stratum.start; index <= stratum.end; index += 1) {
    if (covered.has(index)) fail(`benchmark case index ${index} appears in multiple strata`);
    covered.add(index);
  }
}
const observedSplits = { train: 0, dev: 0, holdout: 0 };
for (let index = 1; index <= 200; index += 1) {
  const remainder = (index - 1) % 4;
  if (remainder === 0 || remainder === 1) observedSplits.train += 1;
  else if (remainder === 2) observedSplits.dev += 1;
  else observedSplits.holdout += 1;
}
if (corpusSpec.case_count !== 200 || covered.size !== 200 || !covered.has(1) || !covered.has(200) ||
    JSON.stringify(observedStrata) !== JSON.stringify(benchmark.primary_strata) ||
    JSON.stringify(corpusSpec.split_rule?.expected_counts) !== JSON.stringify(benchmark.corpus.splits) ||
    JSON.stringify(observedSplits) !== JSON.stringify(benchmark.corpus.splits)) {
  fail("benchmark corpus counts/strata/splits drift");
}

const schema = fs.readFileSync(path.join(DOCS, "schema-contract.md"), "utf8");
for (const version of [27, 28, 29, 30, 31, 32]) {
  const padded = String(version).padStart(3, "0");
  if (!schema.includes(`migration-${padded}`)) fail(`schema contract missing migration-${padded} anchor`);
}
if (!schema.includes("Historical migrations `001` through `026` are immutable")) {
  fail("schema contract does not freeze historical migrations 001-026");
}
if (schema.includes("source_confidence REAL") || !schema.includes("BEGIN IMMEDIATE") ||
    !schema.includes("recall_feedback.trace_id = NULL")) {
  fail("schema contract does not freeze caller-relative confidence and transactional trace detach");
}
const copiedSpec = fs.readFileSync(
  path.join(ROOT, "artifacts/v4/inputs/QOOPIA_V4_PROFESSIONAL_TZ.md"),
  "utf8",
);
if (/schema-30\b/i.test(copiedSpec) || /P02 migration 030\b/i.test(copiedSpec)) {
  fail("copied execution input retains a stale schema-30/P06 migration coordinate");
}
if (copiedSpec.includes("- `source_confidence REAL NULL`.") ||
    !copiedSpec.includes("Confidence не хранится в `memory_lifecycle`") ||
    !copiedSpec.includes("true требует `include_archived=true`, при omitted `latest_only` принудительно делает effective false") ||
    !copiedSpec.includes("`export_plan`, `export_bundle`, `import_plan` имеют risk `admin`")) {
  fail("copied execution input semantic fix-pass mutations drifted");
}

const amendmentEvidencePath = path.join(ROOT, "artifacts/v4/evidence/P01/amendment-consumption.json");
const amendmentEvidence = JSON.parse(fs.readFileSync(amendmentEvidencePath, "utf8")) as {
  copied_spec_pre_fix_sha256?: string;
  copied_spec_operative_sha256?: string;
  copied_spec_diff?: {
    pre_fix_blob?: string;
    operative_blob?: string;
    stats?: {
      contextual_hunks?: number;
      additions?: number;
      deletions?: number;
      semantic_hunks?: number;
      coordinate_hunks?: number;
      zero_context_change_blocks?: number;
    };
    hunks?: Array<{ id?: number; diff_header?: string; class?: string; subject?: string }>;
    other_copied_spec_bytes_changed?: boolean;
  };
  residual_copied_input_mutation_ambiguity?: boolean;
};
const expectedCopiedSpecHunks = [
  { id: 1, diff_header: "@@ -492,12 +492,11 @@", class: "semantic", subject: "lifecycle confidence and protected-record wording" },
  { id: 2, diff_header: "@@ -617,9 +616,9 @@", class: "semantic", subject: "include_history normalization" },
  { id: 3, diff_header: "@@ -631,10 +630,10 @@", class: "semantic", subject: "export/import authorization elevation" },
  { id: 4, diff_header: "@@ -1013,9 +1012,9 @@", class: "coordinate", subject: "P03 fixture schema" },
  { id: 5, diff_header: "@@ -1043,9 +1042,9 @@", class: "coordinate", subject: "P04 fixture schema" },
  { id: 6, diff_header: "@@ -1105,9 +1104,9 @@", class: "coordinate", subject: "P06 receipts migration" },
  { id: 7, diff_header: "@@ -1135,9 +1134,9 @@", class: "coordinate", subject: "P07 fixture schema" },
  { id: 8, diff_header: "@@ -1167,9 +1166,9 @@", class: "coordinate", subject: "P08 clone schema" },
];
const copiedSpecStats = amendmentEvidence.copied_spec_diff?.stats;
if (amendmentEvidence.copied_spec_pre_fix_sha256 !== "e8e04c89e45a8cafe4988631302a6ed27e307cf949849504aedfb5cc77c24f1d" ||
    amendmentEvidence.copied_spec_operative_sha256 !== sha256File(path.join(ROOT, "artifacts/v4/inputs/QOOPIA_V4_PROFESSIONAL_TZ.md")) ||
    amendmentEvidence.copied_spec_diff?.pre_fix_blob !== "11e510e0e140d88f8a8c22ad314012dde96f6d73" ||
    amendmentEvidence.copied_spec_diff?.operative_blob !== "4fce830f1104707339f96da4e069eac7dfd504b3" ||
    copiedSpecStats?.contextual_hunks !== 8 || copiedSpecStats.additions !== 9 || copiedSpecStats.deletions !== 10 ||
    copiedSpecStats.semantic_hunks !== 3 || copiedSpecStats.coordinate_hunks !== 5 ||
    copiedSpecStats.zero_context_change_blocks !== 9 ||
    JSON.stringify(amendmentEvidence.copied_spec_diff?.hunks?.map(({ id, diff_header, class: kind, subject }) =>
      ({ id, diff_header, class: kind, subject }))) !== JSON.stringify(expectedCopiedSpecHunks) ||
    amendmentEvidence.copied_spec_diff?.other_copied_spec_bytes_changed !== false ||
    amendmentEvidence.residual_copied_input_mutation_ambiguity !== false) {
  fail("copied execution input eight-hunk provenance ledger drifted");
}

const exportPolicy = JSON.parse(
  fs.readFileSync(path.join(DOCS, "export-table-policy.json"), "utf8"),
) as {
  database_schema_version?: number;
  logical_table_count?: number;
  tables?: Array<{ ordinal?: number; name?: string; policy?: string; order_by?: unknown[]; projection_id?: string }>;
};
const allowedPolicies = new Set(["required", "optional_ephemeral", "derived", "forbidden", "manifest_only", "local_config"]);
if (exportPolicy.database_schema_version !== 32 || exportPolicy.logical_table_count !== 40 || exportPolicy.tables?.length !== 40) {
  fail("export table policy is not pinned to 40 logical schema-32 tables");
}
for (let index = 0; index < (exportPolicy.tables?.length ?? 0); index += 1) {
  const table = exportPolicy.tables![index]!;
  if (table.ordinal !== index + 1 || !table.name || !table.policy || !allowedPolicies.has(table.policy)) {
    fail(`invalid export table policy entry at ordinal ${index + 1}`);
  }
  if (["required", "optional_ephemeral", "manifest_only"].includes(table.policy) && !table.order_by?.length) {
    fail(`exported/manifest table '${table.name}' lacks deterministic order`);
  }
}
const feedbackPolicy = exportPolicy.tables?.find((table) => table.name === "recall_feedback");
if (feedbackPolicy?.projection_id !== "detach_ephemeral_trace_fk_v1") {
  fail("recall_feedback export policy does not detach excluded ephemeral traces");
}

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-v4-schema-contract-"));
const db = new Database(path.join(scratchRoot, "schema.db"), { create: true });
let migrationNoopGuardPasses = 0;
let retentionContractCases = 0;
try {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);

  const migrationsDir = path.join(ROOT, "migrations");
  const baselineMigrations = fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .filter((name) => Number(name.match(/^\d+/)![0]) <= 26);
  for (const name of baselineMigrations) {
    const version = Number(name.match(/^\d+/)![0]);
    const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT OR IGNORE INTO schema_versions (version, description) VALUES (?, ?)")
        .run(version, name);
    })();
  }

  const sqlBlocks = [...schema.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  if (sqlBlocks.length !== 6) fail(`schema contract must contain six SQL blocks; got ${sqlBlocks.length}`);
  for (const sql of sqlBlocks) {
    const versionMatch = sql.match(/VALUES \((2[7-9]|3[0-2]),/);
    if (!versionMatch) fail("V4 SQL block lacks a schema_versions coordinate");
    const version = Number(versionMatch[1]);
    if (db.query("SELECT 1 FROM schema_versions WHERE version = ?").get(version)) continue;
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT OR IGNORE INTO schema_versions (version, description) VALUES (?, ?)")
        .run(version, `contract-${version}`);
    })();
  }

  for (let pass = 0; pass < 2; pass += 1) {
    for (const sql of sqlBlocks) {
      const version = Number(sql.match(/VALUES \((2[7-9]|3[0-2]),/)![1]);
      if (!db.query("SELECT 1 FROM schema_versions WHERE version = ?").get(version)) {
        fail(`migration-runner no-op guard lost version ${version}`);
      }
    }
    migrationNoopGuardPasses += 1;
  }

  const maxVersion = db.query("SELECT MAX(version) AS version FROM schema_versions")
    .get() as { version: number };
  if (maxVersion.version !== 32) fail(`scratch schema target is ${maxVersion.version}, expected 32`);
  const fkRows = db.query("PRAGMA foreign_key_check").all();
  if (fkRows.length !== 0) fail(`scratch foreign_key_check returned ${fkRows.length} row(s)`);
  const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") fail(`scratch integrity_check=${integrity.integrity_check}`);

  const requiredTables = [
    "note_relations", "note_provenance", "memory_lifecycle", "extraction_runs",
    "extraction_candidates", "recall_traces", "recall_trace_items", "recall_feedback",
    "memory_event_outbox",
  ];
  for (const table of requiredTables) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      fail(`scratch schema missing table ${table}`);
    }
  }

  const ftsLogical = ["notes_fts", "session_messages_fts", "activity_fts", "entity_pages_fts"];
  const ftsShadowSuffixes = new Set(["data", "idx", "content", "docsize", "config"]);
  const logicalTables = (db.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => name !== "sqlite_sequence")
    .filter((name) => !ftsLogical.some((prefix) => {
      if (!name.startsWith(`${prefix}_`)) return false;
      return ftsShadowSuffixes.has(name.slice(prefix.length + 1));
    }))
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const policyTables = (exportPolicy.tables ?? [])
    .map((table) => table.name!)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (JSON.stringify(logicalTables) !== JSON.stringify(policyTables)) {
    fail(`export policy/schema table mismatch: schema=${logicalTables.join(",")} policy=${policyTables.join(",")}`);
  }

  db.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('v4-ws', 'V4 Test', 'v4-test');
    INSERT INTO agents (id, workspace_id, name, type, api_key_hash)
      VALUES ('v4-agent', 'v4-ws', 'V4 Agent', 'standard', 'hash-v4-agent');
    INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, source, tags)
      VALUES ('v4-note', 'v4-ws', 'v4-agent', 'knowledge', 'retention fixture', '{}', 'manual', '[]');
    INSERT INTO recall_traces
      (id, workspace_id, caller_agent_id, query_hash, mode, options, pipeline_version,
       duration_ms, result_count, created_at, expires_at)
      VALUES
      ('v4-trace-1', 'v4-ws', 'v4-agent', '${"a".repeat(64)}', 'hybrid', '{}', 'v4-test',
       1, 1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO recall_trace_items
      (workspace_id, trace_id, result_kind, result_id, note_id, source_channel,
       fts_rank, rrf_score, final_score, final_rank)
      VALUES ('v4-ws', 'v4-trace-1', 'note', 'v4-note', 'v4-note', 'fts5', 1, 0.1, 0.1, 1);
    INSERT INTO recall_feedback
      (id, workspace_id, note_id, trace_id, actor_agent_id, feedback, idempotency_key)
      VALUES ('v4-feedback-1', 'v4-ws', 'v4-note', 'v4-trace-1', 'v4-agent', 'helpful', 'retention-key-1');
  `);
  db.transaction(() => {
    db.query("UPDATE recall_feedback SET trace_id=NULL WHERE workspace_id=? AND trace_id=?")
      .run("v4-ws", "v4-trace-1");
    db.query("DELETE FROM recall_trace_items WHERE workspace_id=? AND trace_id=?")
      .run("v4-ws", "v4-trace-1");
    db.query("DELETE FROM recall_traces WHERE workspace_id=? AND id=?")
      .run("v4-ws", "v4-trace-1");
  })();
  const survived = db.query("SELECT trace_id FROM recall_feedback WHERE id='v4-feedback-1'")
    .get() as { trace_id: string | null } | undefined;
  if (!survived || survived.trace_id !== null ||
      db.query("SELECT 1 FROM recall_traces WHERE id='v4-trace-1'").get() ||
      db.query("SELECT 1 FROM recall_trace_items WHERE trace_id='v4-trace-1'").get()) {
    fail("trace retention detach/delete did not preserve feedback atomically");
  }
  retentionContractCases += 1;

  db.exec(`
    INSERT INTO recall_traces
      (id, workspace_id, caller_agent_id, query_hash, mode, options, pipeline_version,
       duration_ms, result_count, created_at, expires_at)
      VALUES
      ('v4-trace-2', 'v4-ws', 'v4-agent', '${"b".repeat(64)}', 'hybrid', '{}', 'v4-test',
       1, 0, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO recall_feedback
      (id, workspace_id, note_id, trace_id, actor_agent_id, feedback, idempotency_key)
      VALUES ('v4-feedback-2', 'v4-ws', 'v4-note', 'v4-trace-2', 'v4-agent', 'helpful', 'retention-key-2');
  `);
  let rolledBack = false;
  try {
    db.transaction(() => {
      db.query("UPDATE recall_feedback SET trace_id=NULL WHERE workspace_id=? AND trace_id=?")
        .run("v4-ws", "v4-trace-2");
      throw new Error("injected-retention-failure");
    })();
  } catch (error) {
    rolledBack = error instanceof Error && error.message === "injected-retention-failure";
  }
  const rollbackRow = db.query("SELECT trace_id FROM recall_feedback WHERE id='v4-feedback-2'")
    .get() as { trace_id: string | null } | undefined;
  if (!rolledBack || rollbackRow?.trace_id !== "v4-trace-2" ||
      !db.query("SELECT 1 FROM recall_traces WHERE id='v4-trace-2'").get()) {
    fail("trace retention injected failure did not roll back detach");
  }
  retentionContractCases += 1;

  db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  const peer = new Database(path.join(scratchRoot, "schema.db"));
  let concurrentBlocked = false;
  try {
    peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
    peer.query(`INSERT INTO recall_feedback
      (id, workspace_id, note_id, trace_id, actor_agent_id, feedback, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "v4-feedback-peer", "v4-ws", "v4-note", "v4-trace-2", "v4-agent", "helpful", "retention-peer",
      );
  } catch (error) {
    concurrentBlocked = error instanceof Error && /busy|locked/i.test(error.message);
  } finally {
    peer.close();
    db.exec("ROLLBACK");
  }
  if (!concurrentBlocked) fail("BEGIN IMMEDIATE did not serialize concurrent feedback insertion");
  retentionContractCases += 1;

  db.transaction(() => {
    db.query("UPDATE recall_feedback SET trace_id=NULL WHERE workspace_id=? AND trace_id=?")
      .run("v4-ws", "v4-trace-2");
    db.query("DELETE FROM recall_trace_items WHERE workspace_id=? AND trace_id=?")
      .run("v4-ws", "v4-trace-2");
    db.query("DELETE FROM recall_traces WHERE workspace_id=? AND id=?")
      .run("v4-ws", "v4-trace-2");
  })();
  let missingTraceRejected = false;
  try {
    db.query(`INSERT INTO recall_feedback
      (id, workspace_id, note_id, trace_id, actor_agent_id, feedback, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "v4-feedback-late", "v4-ws", "v4-note", "v4-trace-2", "v4-agent", "helpful", "retention-late",
      );
  } catch (error) {
    missingTraceRejected = error instanceof Error && /foreign key/i.test(error.message);
  }
  if (!missingTraceRejected || db.query("PRAGMA foreign_key_check").all().length !== 0) {
    fail("late feedback did not fail closed after trace expiry");
  }
  retentionContractCases += 1;
} finally {
  db.close();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "pass",
  docs: checked.length,
  markdown_files_checked: markdown.length,
  local_links_checked: localLinksChecked,
  requirements: expectedRequirements.length,
  adrs: adrNames.length,
  scratch_schema: 32,
  migration_target: 32,
  migration_apply_passes: 1,
  migration_noop_guard_passes: migrationNoopGuardPasses,
  export_logical_tables: exportPolicy.logical_table_count,
  response_contracts: (delta.new_tools ?? []).length,
  benchmark_cases: corpusSpec.case_count,
  retention_contract_cases: retentionContractCases,
  copied_input_contextual_hunks: expectedCopiedSpecHunks.length,
  copied_input_semantic_hunks: expectedCopiedSpecHunks.filter((hunk) => hunk.class === "semantic").length,
  copied_input_coordinate_hunks: expectedCopiedSpecHunks.filter((hunk) => hunk.class === "coordinate").length,
}));
