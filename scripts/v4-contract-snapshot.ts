import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { objectFromShape } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ROOT = path.resolve(import.meta.dir, "..");
const CURRENT_PATH = path.join(ROOT, "docs/v4/contracts/current-tools.json");
const PROPOSED_PATH = path.join(ROOT, "docs/v4/contracts/proposed-v4-tools.json");
const DELTA_PATH = path.join(ROOT, "docs/v4/tool-contract.json");
const BASELINE_SHA = "b6c169b9c72a2f983933610072b4909ef61261c3";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type CapturedTool = {
  name: string;
  description: string;
  risk: string;
  availability: string;
  input_schema: Json;
  result_schema?: Json;
  authorization?: Json;
};

const ENTITY_TOOLS = new Set([
  "entity_upsert", "entity_get", "entity_search", "entity_link", "entity_page_render",
]);
const SKILL_TOOLS = new Set([
  "skill_upsert", "skill_get", "skill_search", "skill_render_runbook", "skill_mark_tested",
]);
const ADMIN_TOOLS = new Set([
  "agent_onboard", "agent_list", "agent_deactivate", "agent_set_profile",
]);
const V4_TOOL_FLAGS = new Map([
  ["note_relation_list", "QOOPIA_V4_RELATIONS"],
  ["note_supersede", "QOOPIA_V4_RELATIONS"],
  ["extraction_preview", "QOOPIA_V4_EXTRACTION"],
  ["extraction_run_get", "QOOPIA_V4_EXTRACTION"],
  ["extraction_run_list", "QOOPIA_V4_EXTRACTION"],
  ["extraction_review", "QOOPIA_V4_EXTRACTION"],
  ["recall_trace_get", "QOOPIA_V4_RECALL_EXPLAIN"],
  ["recall_feedback", "QOOPIA_V4_FEEDBACK"],
  ["export_plan", "always_after_P08"],
  ["export_bundle", "always_after_P08"],
  ["import_plan", "always_after_P08"],
]);
const V4_RECALL_PROPERTIES = new Set([
  "latest_only", "include_history", "explain", "trace", "lifecycle",
]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function pretty(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stable(value)), null, 2)}\n`;
}

function availability(name: string): string {
  if (V4_TOOL_FLAGS.has(name)) return V4_TOOL_FLAGS.get(name)!;
  if (ENTITY_TOOLS.has(name)) return "QOOPIA_ENTITY_PAGES";
  if (SKILL_TOOLS.has(name)) return "QOOPIA_SKILLS";
  if (ADMIN_TOOLS.has(name)) return "steward_only";
  return "always";
}

async function captureCurrent() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-v4-contract-"));
  process.env.NODE_ENV = "test";
  process.env.QOOPIA_DATA_DIR = path.join(tmpRoot, "data");
  process.env.QOOPIA_LOG_DIR = path.join(tmpRoot, "logs");
  process.env.QOOPIA_BACKUP_DIR = path.join(tmpRoot, "backups");
  process.env.QOOPIA_PORT = "0";
  process.env.QOOPIA_LOG_LEVEL = "error";
  process.env.QOOPIA_ENTITY_PAGES = "true";
  process.env.QOOPIA_SKILLS = "true";
  process.env.QOOPIA_ENABLE_V2_COMPAT = "false";
  process.env.QOOPIA_V4_RELATIONS = "true";
  process.env.QOOPIA_V4_LATEST_ONLY = "true";
  process.env.QOOPIA_V4_EXTRACTION = "true";
  process.env.QOOPIA_V4_RECALL_EXPLAIN = "true";
  process.env.QOOPIA_V4_FEEDBACK = "true";

  const { registerTools, riskOf } = await import("../src/mcp/tools.ts");
  const captured: CapturedTool[] = [];
  const fakeServer = {
    registerTool(name: string, config: { description: string; inputSchema: { shape: Record<string, unknown> } }, handler: unknown) {
      return this.tool(name, config.description, config.inputSchema.shape, handler);
    },
    tool(name: string, description: string, rawSchema: Record<string, unknown>, _handler: unknown) {
      const objectSchema = objectFromShape(rawSchema as never);
      const inputSchema = toJsonSchemaCompat(objectSchema, { target: "jsonSchema7" }) as Json;
      captured.push({
        name,
        description,
        risk: riskOf(name) ?? "unknown",
        availability: availability(name),
        input_schema: inputSchema,
      });
      return {};
    },
  };

  registerTools(fakeServer as unknown as McpServer, () => null, "full", {
    isSteward: true,
    agentToolProfile: "full",
  });

  process.env.QOOPIA_ENABLE_V2_COMPAT = "true";
  const withCompat: string[] = [];
  const compatServer = { registerTool(name: string) { withCompat.push(name); return {}; }, tool(name: string) { withCompat.push(name); return {}; } };
  registerTools(compatServer as unknown as McpServer, () => null, "full", {
    isSteward: true,
    agentToolProfile: "full",
  });

  const canonicalNames = new Set(captured.map((tool) => tool.name));
  const aliases = [...new Set(withCompat.filter((name) => !canonicalNames.has(name)))]
    .sort()
    .map((name) => ({ name, risk: riskOf(name) ?? "unknown" }));

  const { closeDb } = await import("../src/db/connection.ts");
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  return {
    schema_version: 1,
    baseline_sha: BASELINE_SHA,
    source_modules: [
      "src/mcp/tools.ts", "src/mcp/entity_tools.ts", "src/mcp/skill_tools.ts",
      "src/mcp/admin-tools.ts", "src/mcp/compat.ts", "src/mcp/v4-tools.ts",
    ],
    canonical_tools: captured.sort((a, b) => a.name.localeCompare(b.name)),
    legacy_compat_overlay: {
      enable_flag: "QOOPIA_ENABLE_V2_COMPAT",
      default_enabled: false,
      aliases,
      brief_agent_name_overlay: true,
    },
  };
}

function baselineFromLive(live: Awaited<ReturnType<typeof captureCurrent>>) {
  const baseline = structuredClone(live);
  baseline.canonical_tools = baseline.canonical_tools.filter(
    (tool) => !V4_TOOL_FLAGS.has(tool.name),
  );
  const recall = baseline.canonical_tools.find((tool) => tool.name === "recall");
  const properties = recall?.input_schema && typeof recall.input_schema === "object"
    ? (recall.input_schema as { properties?: Record<string, Json> }).properties
    : undefined;
  if (!properties) throw new Error("live recall schema has no properties");
  for (const name of V4_RECALL_PROPERTIES) delete properties[name];
  return baseline;
}

/** P1's explicitly permitted safety changes, checked before comparing the remaining frozen V3/V4 contract. */
function checkedP1Projection(live: Awaited<ReturnType<typeof captureCurrent>>) {
  const projected = structuredClone(live);
  const historical = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8")) as { canonical_tools: CapturedTool[] };
  const recall = projected.canonical_tools.find((tool) => tool.name === "recall");
  const beforeRecall = historical.canonical_tools.find((tool) => tool.name === "recall")!;
  // V1 changes explanatory copy for built-in retrieval/subscription judging;
  // the input types, risk and envelope remain part of the frozen contract.
  if (!recall?.description.includes('4k serialized-byte envelope') || !recall.description.includes('connected workspace subscription')) throw new Error("V1 recall budget/subscription description drift");
  recall.description = beforeRecall.description;
  const recallProps = (recall.input_schema as {properties: Record<string, Record<string, Json>>}).properties;
  const oldRecallProps = (beforeRecall.input_schema as {properties: Record<string, Record<string, Json>>}).properties;
  for (const field of ['query','deep','deep_llm']) recallProps[field]!.description=oldRecallProps[field]!.description!;
  for (const name of ["entity_upsert", "skill_upsert", "skill_mark_tested"]) {
    const tool = projected.canonical_tools.find((t) => t.name === name);
    if (!tool) throw new Error(`P1 compatibility facade missing: ${name}`);
    const schema = tool.input_schema as { properties: Record<string, Json>; required?: string[] };
    const before = historical.canonical_tools.find((t) => t.name === name)!;
    if (name === "skill_upsert") {
      if (!tool.description.startsWith("Compatibility: create an immutable draft revision")) throw new Error("P1 skill writer must describe immutable revisions");
      tool.description = before.description;
    }
    if (name === "skill_mark_tested") {
      if (!tool.description.startsWith("Record a self-reported test event") || !tool.description.includes("authenticated principal")) throw new Error("P1 test event must describe actual self-report attribution");
      tool.description = before.description;
      const oldProps = (before.input_schema as { properties: Record<string, Json> }).properties;
      for (const field of ["tested_at", "tester_agent"]) {
        const prop = schema.properties[field] as Record<string, Json>;
        const expectedDescription = field === "tested_at" ? "ISO timestamp reported by the authenticated tester." : "Authenticated reporter ID or name; another principal is forbidden.";
        if (prop.description !== expectedDescription) throw new Error(`P1 reporter description drift: ${field}`);
        prop.description = (oldProps[field] as Record<string, Json>).description!;
      }
    }
    if (stable(schema.properties.expected_revision) !== stable({ type: "integer", minimum: name === "skill_mark_tested" ? 1 : 0 })) {
      throw new Error(`P1 CAS precondition schema drift: ${name}`);
    }
    if (stable(schema.properties.idempotency_key) !== stable({ type: "string", minLength: 1, maxLength: 128 })) {
      throw new Error(`P1 idempotency schema drift: ${name}`);
    }
    for (const field of ["expected_revision", "idempotency_key"]) {
      if ((schema.required ?? []).includes(field) !== (name !== "entity_upsert")) throw new Error(`P1 required precondition drift: ${name}.${field}`);
      delete schema.properties[field];
    }
    schema.required = schema.required?.filter((field) => field !== "expected_revision" && field !== "idempotency_key");
    if (name === "skill_upsert") {
      const metadata = schema.properties.metadata as { additionalProperties: boolean };
      if (metadata.additionalProperties !== false) throw new Error("P1 skill metadata must reject unknown fields");
      metadata.additionalProperties = true; // historical comparison only; live schema remains closed
    }
  }
  return projected;
}

function assertLiveP05(
  live: Awaited<ReturnType<typeof captureCurrent>>,
  proposed: ReturnType<typeof buildProposed>,
) {
  const p08Bound = live.canonical_tools.some((tool) => tool.name === "export_plan");
  const expected = proposed.canonical_tools.filter(
    (tool) => p08Bound || tool.availability !== "always_after_P08",
  );
  const byName = new Map(live.canonical_tools.map((tool) => [tool.name, tool]));
  for (const tool of expected) {
    const actual = byName.get(tool.name);
    if (!actual) throw new Error(`live V4 tool missing: ${tool.name}`);
    if (actual.risk !== tool.risk) throw new Error(`live V4 risk drift: ${tool.name}`);
    const expectedSchema = structuredClone(tool.input_schema) as {
      properties?: Record<string, { uniqueItems?: boolean }>;
    };
    // Zod enforces this in the handler schema, but its draft-07 converter does
    // not emit uniqueItems for arrays. Keep the frozen JSON contract strict.
    if (tool.name === "note_relation_list") {
      delete expectedSchema.properties?.relation_types?.uniqueItems;
    }
    if (tool.name === "note_supersede") {
      const metadata = expectedSchema.properties?.metadata as
        | { additionalProperties?: unknown }
        | undefined;
      if (metadata?.additionalProperties === true) metadata.additionalProperties = {};
    }
    if (stable(actual.input_schema) !== stable(expectedSchema)) {
      throw new Error(`live V4 input schema drift: ${tool.name}`);
    }
  }
  const expectedNames = new Set(expected.map((tool) => tool.name));
  const extras = live.canonical_tools.filter((tool) => !expectedNames.has(tool.name));
  if (extras.length) throw new Error(`unexpected live V4 tools: ${extras.map((tool) => tool.name).join(",")}`);
}

function buildProposed(current: Awaited<ReturnType<typeof captureCurrent>>) {
  const delta = JSON.parse(fs.readFileSync(DELTA_PATH, "utf8")) as {
    schema_version: number;
    target_version: string;
    migration_target: number;
    response_schema_registry: Record<string, Json>;
    authorization_contract: Record<string, Json>;
    recall_optional_properties: Record<string, Json>;
    new_tools: CapturedTool[];
    compatibility: Record<string, Json>;
  };
  if (delta.schema_version !== 2 || delta.migration_target !== 32) {
    throw new Error("tool-contract.json must target contract schema 2 and DB schema 32");
  }

  const canonical = structuredClone(current.canonical_tools);
  const recall = canonical.find((tool) => tool.name === "recall");
  if (!recall) throw new Error("current recall tool missing");
  const recallSchema = recall.input_schema as { properties?: Record<string, Json> };
  if (!recallSchema.properties) throw new Error("current recall schema has no properties");
  for (const [name, property] of Object.entries(delta.recall_optional_properties)) {
    if (name in recallSchema.properties) {
      throw new Error(`recall addition '${name}' already exists in the V3 snapshot`);
    }
    recallSchema.properties[name] = property;
  }

  const names = new Set(canonical.map((tool) => tool.name));
  for (const tool of delta.new_tools) {
    if (names.has(tool.name)) throw new Error(`new tool '${tool.name}' collides with V3`);
    if (!tool.result_schema || !tool.authorization) {
      throw new Error(`new tool '${tool.name}' lacks frozen result or authorization contract`);
    }
    names.add(tool.name);
    canonical.push(tool);
  }
  for (const alias of current.legacy_compat_overlay.aliases) {
    if (names.has(alias.name)) {
      throw new Error(`legacy alias '${alias.name}' leaked into the canonical V4 surface`);
    }
  }

  return {
    schema_version: delta.schema_version,
    target_version: delta.target_version,
    baseline_sha: BASELINE_SHA,
    migration_target: delta.migration_target,
    additive_only: true,
    response_schema_registry: delta.response_schema_registry,
    authorization_contract: delta.authorization_contract,
    canonical_tools: canonical.sort((a, b) => a.name.localeCompare(b.name)),
    legacy_compat_overlay: current.legacy_compat_overlay,
    compatibility: delta.compatibility,
  };
}

function assertMatches(file: string, expected: unknown) {
  if (!fs.existsSync(file)) throw new Error(`snapshot missing: ${path.relative(ROOT, file)}`);
  const actual = fs.readFileSync(file, "utf8");
  const wanted = pretty(expected);
  if (actual !== wanted) {
    throw new Error(`snapshot drift: ${path.relative(ROOT, file)}; run bun run scripts/v4-contract-snapshot.ts --write and review the diff`);
  }
}

const capturedLive = await captureCurrent();
const p1 = process.argv.includes("--p1");
if (p1 && process.argv.includes("--write")) throw new Error("P1 must not overwrite historical V3/V4 snapshots");
const live = p1 ? checkedP1Projection(capturedLive) : capturedLive;
const current = baselineFromLive(live);
const proposed = buildProposed(current);
const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;

if (write) {
  fs.mkdirSync(path.dirname(CURRENT_PATH), { recursive: true });
  fs.writeFileSync(CURRENT_PATH, pretty(current));
  fs.writeFileSync(PROPOSED_PATH, pretty(proposed));
  console.log(`wrote ${path.relative(ROOT, CURRENT_PATH)}`);
  console.log(`wrote ${path.relative(ROOT, PROPOSED_PATH)}`);
}
if (check) {
  assertMatches(CURRENT_PATH, current);
  assertMatches(PROPOSED_PATH, proposed);
  assertLiveP05(live, proposed);
  console.log(JSON.stringify({
    status: "pass",
    ...(p1 ? { contract: "P1 explicit CAS/idempotency/closed-metadata delta plus frozen V3/V4 remainder" } : {}),
    baseline_sha: BASELINE_SHA,
    current_tools: current.canonical_tools.length,
    proposed_tools: proposed.canonical_tools.length,
    live_p05_tools: live.canonical_tools.length,
    migration_target: proposed.migration_target,
  }));
}
