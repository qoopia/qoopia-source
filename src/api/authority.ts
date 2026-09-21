import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { db } from "../db/connection.ts";
import { authenticate, type AuthContext } from "../auth/middleware.ts";
import { authorize, type AuthorityAction } from "../auth/policy.ts";
import { issuePairing, pairingSchema, redeemPairing, revokePrincipal, revokePrincipalSchema } from "../auth/pairings.ts";
import { reviseDraft, reviseSchema, compileDraft, compileSchema, reviewSkill, reviewSchema,
  sealSkill, sealSchema, registerPublisherKey, signingKeySchema, getSkillVersion, requireSkillRead } from "../skills/authority.ts";
import { canonical, digest } from "../skills/commands.ts";
import { COMPILER, RENDERER, NATIVE_RENDERER, renderRunbook, type SkillContent } from "../skills/format.ts";
import { QoopiaError } from "../utils/errors.ts";
import { recordStorageWriteFailure } from "../utils/storage-degradation.ts";
import { readPackage } from "../skills/legacy/archive.ts";
import { getV4FeatureFlags } from "../utils/health-metadata.ts";
import { agentContract, agentContractFor } from "./agent-contract.ts";
import { agentMemoryStatus, listMemoryPolicies, memoryPolicy, resolveAgentByName } from "../services/memory-policy.ts";

import { importPreview, importPreviewSchema, resolveImport, resolveImportSchema } from '../skills/import-review.ts';
import { captureSkill, captureSchema } from '../skills/capture.ts';
import { acceptLocalSkill, acceptSchema, configureRuntime, configureSchema, assignSkill, assignSchema, updateAssignment, updateSchema,
  skillLifecycle, lifecycleSchema, sessionOpen, sessionSchema, sessionGet, loadoutSchema, loopView, viewSchema, runtimeCapabilities } from '../skills/loop.ts';
import { claimProjection, claimSchema, authorizeRun, runSchema, observeRuntime, observationSchema, recordOutcome, outcomeSchema, rateSkill, ratingSchema } from '../skills/runtime.ts';

const identifier = z.string().min(1).max(200);
export const searchSchema = z.object({ query: z.string().max(1000).default(""), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().max(2000).optional() }).strict();
export const getSchema = z.object({ id: identifier.optional(), slug: identifier.optional(), version_id: identifier.optional() }).strict();
type Handler = (auth: AuthContext, args: unknown, database: Database) => unknown;
interface Operation { name: string; method: string; path: string; action: AuthorityAction; schema: z.AnyZodObject; handler: Handler; description: string; humanOnly?: boolean; }

export function searchSkills(auth: AuthContext, raw: unknown, database: Database = db) {
  const a = searchSchema.parse(raw), p = authorize(database, auth, "read");
  const binding = digest(canonical({ workspace: p.workspace_id, actor: p.id, query: a.query, limit: a.limit }));
  let snapshot = Date.now(), afterMs = -1, afterId = "";
  if (a.cursor) {
    let c: unknown;
    try { c = JSON.parse(Buffer.from(a.cursor, "base64url").toString()); } catch { throw new QoopiaError("INVALID_INPUT", "Invalid cursor"); }
    const parsed = z.object({ binding: z.literal(binding), snapshot: z.number().int().positive(), ms: z.number().int().nonnegative(), id: identifier }).strict().safeParse(c);
    if (!parsed.success) throw new QoopiaError("INVALID_INPUT", "Cursor does not match filters or principal");
    snapshot = parsed.data.snapshot; afterMs = parsed.data.ms; afterId = parsed.data.id;
  }
  const rows = database.query(`WITH visible AS (
    SELECT e.id,e.slug,COALESCE(r.content_json,json_object('title',e.title)) AS content_json,
      COALESCE(r.created_at_ms,CAST(strftime('%s',e.updated_at) AS INTEGER)*1000) AS updated_at_ms,
      d.id AS draft_id,COALESCE(r.revision_no,0) AS revision
    FROM entity_pages e LEFT JOIN skill_drafts d ON d.skill_id=e.id
    LEFT JOIN skill_draft_revisions r ON r.draft_id=d.id AND r.revision_no=(SELECT max(r2.revision_no) FROM skill_draft_revisions r2 WHERE r2.draft_id=d.id AND r2.created_at_ms<=?)
    WHERE e.workspace_id=? AND e.type='skill' AND (d.id IS NULL OR r.id IS NOT NULL)
      AND (e.authority_private=0 OR e.authority_owner_id=? OR EXISTS(SELECT 1 FROM workspace_owners WHERE workspace_id=e.workspace_id AND actor_id=?))
    ) SELECT * FROM visible WHERE updated_at_ms<=? AND (updated_at_ms>? OR (updated_at_ms=? AND id>?))
      AND instr(lower(json_extract(content_json,'$.title')),lower(?))>0 ORDER BY updated_at_ms,id LIMIT ?`)
    .all(snapshot, p.workspace_id, p.id, p.id, snapshot, afterMs, afterMs, afterId, a.query, a.limit + 1) as Array<{
      id: string; slug: string; content_json: string; updated_at_ms: number; draft_id: string | null; revision: number;
    }>;
  const items = rows.slice(0, a.limit).map(({ content_json, ...row }) => ({ ...row, title: (JSON.parse(content_json) as SkillContent).title }));
  const last = items.at(-1);
  return { items, next_cursor: rows.length > a.limit && last ? Buffer.from(canonical({ binding, snapshot, ms: last.updated_at_ms, id: last.id })).toString("base64url") : null,
    snapshot_at: new Date(snapshot).toISOString(), completeness: "complete_at_snapshot" };
}
export function getSkill(auth: AuthContext, raw: unknown, database: Database = db) {
  const a = getSchema.parse(raw), p = authorize(database, auth, "read");
  if (a.version_id) {
    const version = getSkillVersion(auth, a.version_id, database);
    if (a.id && version.skill_id !== a.id) throw new QoopiaError("NOT_FOUND", "Version does not belong to this skill");
    return version;
  }
  if ((!a.id && !a.slug) || (a.id && a.slug)) throw new QoopiaError("INVALID_INPUT", "Exactly one skill id or slug is required");
  const row = database.query(`SELECT d.id AS draft_id,d.skill_id,e.slug,d.revision,r.id AS revision_id,r.content_digest,r.content_json,r.missing_requirements
    FROM skill_drafts d JOIN entity_pages e ON e.id=d.skill_id JOIN skill_draft_revisions r ON r.id=d.head_revision_id
    WHERE d.workspace_id=? AND (d.skill_id=? OR e.slug=?)`).get(p.workspace_id, a.id ?? null, a.slug ?? null) as Record<string, unknown> | null;
  if (!row) {
    const identity = database.query("SELECT id,slug,title FROM entity_pages WHERE workspace_id=? AND type='skill' AND (id=? OR slug=?)")
      .get(p.workspace_id, a.id ?? null, a.slug ?? null) as {id:string;slug:string;title:string}|null;
    if (!identity) throw new QoopiaError("NOT_FOUND", "Skill not found");
    requireSkillRead(database,p,identity.id);
    return {...identity, skill_id:identity.id,draft:null,versions:database.query("SELECT id,version_label,original_format,status,package_digest FROM skill_versions WHERE skill_id=? AND workspace_id=? ORDER BY created_at_ms,id").all(identity.id,p.workspace_id)};
  }
  requireSkillRead(database, p, String(row.skill_id));
  return { ...row, skill_id: String(row.skill_id), content: JSON.parse(String(row.content_json)), content_json: undefined,
    missing_requirements: JSON.parse(String(row.missing_requirements)) };
}
export function getOperation(auth: AuthContext, raw: unknown, database: Database = db) {
  const a = z.object({ id: identifier }).strict().parse(raw), p = authorize(database, auth, "read");
  const row = database.query("SELECT * FROM authority_commands WHERE id=? AND workspace_id=? AND actor_id=?")
    .get(a.id, p.workspace_id, p.id) as { response_json: string; operation: string; created_at_ms: number } | null;
  if (!row) throw new QoopiaError("NOT_FOUND", "Operation not found in requester scope");
  const pending=row.operation==='skill_session_open'?database.query('SELECT state,attempt_count,last_error_code FROM memory_event_outbox WHERE aggregate_id=?').get(a.id) as {state:string;attempt_count:number;last_error_code:string|null}|null:null;
  return { id: a.id, state: pending?.state??"completed", delivery:pending, operation: row.operation, created_at_ms: row.created_at_ms,
    result: JSON.parse(row.response_json), retryable: pending?.state==='failed', cancelable: false };
}

export function getRunbook(auth: AuthContext, raw: unknown, database: Database = db) {
  const skill = getSkill(auth, raw, database);
  if ("content" in skill) return { markdown: renderRunbook(skill.content), skill_id: skill.skill_id };
  if ("members_json" in skill) {
    const encoded = (JSON.parse(String(skill.members_json)) as Record<string, string>)["SKILL.md"];
    if (encoded) return { markdown: Buffer.from(encoded, "base64").toString("utf8"), skill_id: skill.skill_id, version_id: skill.id };
  }
  if ("original_format" in skill && skill.original_format === "skillonomia-legacy") {
    const row = database.query("SELECT package_bytes FROM skill_versions WHERE id=? AND workspace_id=?")
      .get(String(skill.id), auth.workspace_id) as { package_bytes: Uint8Array };
    const bytes = Buffer.from(row.package_bytes);
    const markdown = readPackage(bytes, bytes[0] === 0x1f && bytes[1] === 0x8b ? "tar.gz" : "tar").get("SKILL.md");
    if (markdown) return { markdown: markdown.toString("utf8"), skill_id: skill.skill_id, version_id: skill.id };
  }
  throw new QoopiaError("UNSUPPORTED", "This historical version has no frozen runbook; read its original version record");
}

export const authorityOperations: readonly Operation[] = [
  { name: 'skill_import_review', method: 'GET', path: '/skill-imports/:origin/review', action: 'owner', schema: importPreviewSchema, handler: importPreview, humanOnly: true, description: 'Inspect paused imported assignments, original approval scopes and explicit conflicts.' },
  { name: 'skill_import_resolve', method: 'POST', path: '/skill-imports/:origin/resolve', action: 'owner', schema: resolveImportSchema, handler: resolveImport, humanOnly: true, description: 'Resolve one imported assignment through current exact review without widening its source scope.' },
  { name: 'skill_capture', method: 'POST', path: '/skills/captures', action: 'draft', schema: captureSchema, handler: captureSkill, description: 'Capture a selected source into a redacted editable draft; one-off work remains memory.' },
  { name: 'skill_accept', method: 'POST', path: '/skills/candidates/:version_id/accept', action: 'owner', schema: acceptSchema, handler: acceptLocalSkill, humanOnly: true, description: 'Human review and local acceptance of exact final bytes; one-package local attestation is not an author signature.' },
  { name: 'runtime_configure', method: 'POST', path: '/runtime/registrations/:runtime_id/configure', action: 'owner', schema: configureSchema, handler: configureRuntime, humanOnly: true, description: 'Configure an enrolled runtime against the exact-version adapter matrix.' },
  { name: 'skill_assign', method: 'POST', path: '/skill-assignments', action: 'owner', schema: assignSchema, handler: assignSkill, humanOnly: true, description: 'Assign, replace or roll back exact approved bytes for the next session.' },
  { name: 'skill_assignment_update', method: 'PATCH', path: '/skill-assignments/:assignment_id', action: 'owner', schema: updateSchema, handler: updateAssignment, humanOnly: true, description: 'Pause or revoke an assignment without rewriting frozen history.' },
  { name: 'skill_lifecycle', method: 'POST', path: '/skills/versions/:version_id/lifecycle', action: 'owner', schema: lifecycleSchema, handler: skillLifecycle, humanOnly: true, description: 'Append deprecation, supersession or irreversible revoke policy.' },
  { name: 'skill_session_open', method: 'POST', path: '/runtime/sessions', action: 'report', schema: sessionSchema, handler: sessionOpen, description: 'Enrolled reporter opens a frozen session generation. Changed assignments affect the next session.' },
  { name: 'skill_session_get', method: 'GET', path: '/runtime/sessions/:loadout_id/loadout', action: 'report', schema: loadoutSchema, handler: sessionGet, description: 'Read the frozen loadout and current revoke overlay.' },
  { name: 'runtime_claim', method: 'POST', path: '/runtime/claims', action: 'report', schema: claimSchema, handler: claimProjection, description: 'Claim the session projection outbox with a bounded fencing lease.' },
  { name: 'skill_run_authorize', method: 'POST', path: '/runtime/runs', action: 'report', schema: runSchema, handler: authorizeRun, description: 'Authorize an exact entry online against a predeclared task evaluator before managed launch.' },
  { name: 'skill_observe', method: 'POST', path: '/runtime/observations', action: 'report', schema: observationSchema, handler: observeRuntime, description: 'Record authenticated projection or runtime facts, never inferred task success.' },
  { name: 'skill_feedback', method: 'POST', path: '/skill-feedback', action: 'feedback', schema: outcomeSchema.extend({evidence_class:z.literal('self_report')}), handler: (auth,args,database)=>recordOutcome(auth,outcomeSchema.extend({evidence_class:z.literal('self_report')}).parse(args),database), description: 'Append participant self-report, never independent task evidence.' },
  { name: 'skill_outcome', method: 'POST', path: '/runs/:run_id/outcomes', action: 'report', schema: outcomeSchema, handler: recordOutcome, description: 'Append exact-run evaluator results; marker-only receipts cannot verify a useful task.' },
  { name: 'skill_rate', method: 'POST', path: '/skills/versions/:version_id/ratings', action: 'feedback', schema: ratingSchema, handler: rateSkill, description: 'Version/run feedback with immutable revisions and deduplication; no independent reputation claim.' },
  { name: 'skill_loop', method: 'GET', path: '/skill-loop', action: 'read', schema: viewSchema, handler: loopView, description: 'Inspect desired assignments, version-linked outcomes and attention states in one library.' },
  { name: "skill_draft_revise", method: "PATCH", path: "/skills/drafts/:draft_id", action: "draft", schema: reviseSchema, handler: reviseDraft, description: "Create or revise an immutable structured draft using expected_revision; creation uses /skills/drafts." },
  { name: "skill_compile", method: "POST", path: "/skills/drafts/:draft_id/compile", action: "draft", schema: compileSchema, handler: compileDraft, description: "Compile the exact revision into frozen candidate bytes without executing them." },
  { name: "skill_review", method: "POST", path: "/skills/candidates/:version_id/reviews", action: "review", schema: reviewSchema, handler: reviewSkill, description: "Record an exact digest review; human adoption consent has separate bindings." },
  { name: "skill_seal", method: "POST", path: "/skills/candidates/:version_id/seal", action: "seal", schema: sealSchema, handler: sealSkill, description: "Seal approved candidate bytes with a detached signature from a registered publisher." },
  { name: "publisher_key_register", method: "POST", path: "/publisher-keys", action: "owner", schema: signingKeySchema, handler: registerPublisherKey, description: "Register a public publisher key; no private key is sent to the server.", humanOnly: true },
  { name: "agent_pairing_create", method: "POST", path: "/agent-pairings", action: "owner", schema: pairingSchema, handler: issuePairing, description: "Issue a scoped single-use ten-minute agent or reporter pairing.", humanOnly: true },
  { name: "principal_revoke", method: "POST", path: "/principals/:agent_id/revoke", action: "owner", schema: revokePrincipalSchema, handler: revokePrincipal, description: "Revoke a principal and fence its authentication generation.", humanOnly: true },
  { name: "skill_search", method: "GET", path: "/skills", action: "read", schema: searchSchema, handler: searchSkills, description: "List authorized skill identities with a filter-bound cursor." },
  { name: "skill_get", method: "GET", path: "/skills/:id", action: "read", schema: getSchema, handler: getSkill, description: "Read a skill draft or exact immutable version in the current workspace." },
  { name: "skill_render_runbook", method: "GET", path: "/skills/:id/runbook", action: "read", schema: getSchema,
    handler: getRunbook, description: "Read an exact frozen version runbook or render the current draft; this grants no execution permission." },
  { name: "operation_get", method: "GET", path: "/operations/:id", action: "read", schema: z.object({ id: identifier }).strict(), handler: getOperation, description: "Read the authenticated requester's committed operation." },
];

export function effectiveAuthority(auth?: AuthContext, database: Database = db) {
  const publicPart = { api_version: "1", phase: "P2", compiler: COMPILER, renderer: RENDERER, native_renderer:NATIVE_RENDERER,
    format: "qoopia-skill-package/1", limits: { mutations_per_principal_per_minute: 120, pairing_ttl_ms: 600_000, member_bytes: 4 * 1024 * 1024, members: 512 },
    runtime_activation: "session_projection", runtime_capabilities: runtimeCapabilities, autonomous_owner_installation: "unavailable_P3" };
  if (!auth) return publicPart;
  const row = database.query("SELECT authority_profile,policy_epoch,memory_mode,memory_mode_revision FROM agents WHERE id=? AND workspace_id=? AND active=1")
    .get(auth.agent_id, auth.workspace_id) as { authority_profile: string; policy_epoch: number; memory_mode: string; memory_mode_revision: number } | null;
  if (!row) throw new QoopiaError("UNAUTHENTICATED", "Principal is inactive");
  const ops = authorityOperations.filter((op) => {
    try { authorize(database, auth, op.action); return true; } catch { return false; }
  }).map((op) => ({ name: op.name, method: op.method, path: `/api/v1${op.path}`, risk: op.action,
    input_schema: toJsonSchemaCompat(op.schema, { target: "jsonSchema7" }) }));
  // Part of the digest on purpose: a client comparing digests notices that the owner changed the mode.
  const memory_policy = { mode: row.memory_mode, revision: row.memory_mode_revision,
    automatic_capture: row.memory_mode === "auto" ? "allowed" : "refused_with_APPROVAL_REQUIRED", managed_by: "workspace owner" };
  const config = { ...publicPart, profile: row.authority_profile, policy_epoch: row.policy_epoch, memory_policy, operations: ops, flags: getV4FeatureFlags(),
    authority_outbox: "transactional_session_claims", client_refresh: "Reconnect after an explicit profile change" };
  return { ...config, config_digest: digest(canonical(config)), ...agentContract(database, auth, authorityOperations) };
}

/** The owner's question «who has what working?» answered from the same contract each agent reads for itself. */
export function agentCoverage(auth: AuthContext | null, target: string, database: Database = db) {
  if (!auth) throw new QoopiaError("UNAUTHENTICATED", "Authentication required");
  const self = target === auth.agent_id;
  if (!self && auth.type !== "steward" && auth.type !== "owner") throw new QoopiaError("FORBIDDEN", "Only the steward or the owner reads another agent's contract");
  const describe = (id: string, name: string) => ({ agent_id: id, name, memory: agentMemoryStatus(auth.workspace_id, id),
    ...agentContractFor(database, auth.workspace_id, id, authorityOperations) });
  if (target === "all") return { agents: listMemoryPolicies(auth.workspace_id).map((a) => {
    const row = describe(a.agent_id, a.name);
    return { agent_id: row.agent_id, name: row.name, memory_mode: row.memory.mode, memory_channel: row.memory.state, connection: row.connection ?? null,
      coverage: Object.fromEntries((row.mechanisms ?? []).map((m) => [m.id, m.status])) };
  }) };
  let found: { agent_id: string; name: string };
  try { found = memoryPolicy(auth.workspace_id, target); } catch { found = resolveAgentByName(auth.workspace_id, target); }
  return describe(found.agent_id, found.name);
}

export function apiError(error: unknown, requestId = randomUUID()) {
  if (recordStorageWriteFailure(error)) error = new QoopiaError("STORAGE_FULL", "SQLite storage capacity exhausted; writes are disabled. Free storage capacity, then restart Qoopia and verify /ready before resuming writes.");
  const code = error instanceof QoopiaError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "INTERNAL";
  const statuses: Record<string, number> = { INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAUTHORIZED: 401, FORBIDDEN: 403, APPROVAL_REQUIRED: 403,
    NOT_FOUND: 404, MANUAL_DRIFT: 409, CONFLICT: 409, STALE_REVISION: 409, IDEMPOTENCY_MISMATCH: 409, EXPIRED: 410, REVOKED: 410, SIZE_LIMIT: 413,
    UNSUPPORTED: 422, QUARANTINED: 422, LICENSE_REQUIRED: 422, UNTRUSTED_SIGNING_KEY: 422, CHECKSUM_MISMATCH: 422, RATE_LIMITED: 429, DEPENDENCY_UNAVAILABLE: 503, NOT_READY: 503, STORAGE_FULL: 507 };
  return { status: statuses[code] ?? 500, error: { code, retryable: code === "RATE_LIMITED" || code === "DEPENDENCY_UNAVAILABLE",
    message: error instanceof QoopiaError ? error.message : code === "INVALID_INPUT" ? "Request does not match the closed schema" : "Internal operation failure",
    next_action: code === "STALE_REVISION" ? "Preserve submitted edits, reload and rebase" : "Inspect the current capability and object state", request_id: requestId,
    ...(error instanceof QoopiaError && error.details ? { details: error.details } : {}) } };
}

/** HTTP/CLI/MCP invoke these exact typed handlers, never a second writer. */
export async function handleAuthorityRequest(request: Request, database: Database = db, context?: AuthContext | null): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/v1/, ""), auth = context === undefined ? authenticate(request) : context;
    if (request.method === "GET" && path === "/capabilities") return Response.json(effectiveAuthority(auth ?? undefined, database));
    if (request.method === "POST" && path === "/agent-pairings/redeem") {
      const body = await request.text();
      if (Buffer.byteLength(body) > 1024) throw new QoopiaError("SIZE_LIMIT", "Pairing redemption exceeds 1 KiB");
      const input = z.object({ code: z.string().max(100) }).strict().parse(JSON.parse(body));
      return Response.json(redeemPairing(input.code, database));
    }
    if (!auth) throw new QoopiaError("UNAUTHENTICATED", "Bearer authentication required");
    let found: Operation | undefined, params: Record<string, unknown> = {};
    if (path === "/skills/drafts" && request.method === "POST") found = authorityOperations.find(op => op.name === "skill_draft_revise");
    const exactVersion = /^\/skills\/([^/]+)\/versions\/([^/]+)$/.exec(path);
    if (exactVersion && request.method === "GET") {
      found = authorityOperations.find((op) => op.name === "skill_get");
      params = { id: decodeURIComponent(exactVersion[1]!), version_id: decodeURIComponent(exactVersion[2]!) };
    }
    for (const op of authorityOperations) {
      if (found || request.method !== op.method) continue;
      const names: string[] = [];
      const pattern = op.path.replace(/:([a-z_]+)/g, (_, name: string) => { names.push(name); return "([^/]+)"; });
      const match = new RegExp(`^${pattern}$`).exec(path);
      if (match) { found = op; names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]!); }); }
    }
    if (!found) throw new QoopiaError("NOT_FOUND", "No typed operation at this method and path");
    if (request.method === "GET") {
      for (const [name, value] of url.searchParams) {
        if (params[name] !== undefined && params[name] !== value) throw new QoopiaError("INVALID_INPUT", "Path and query identity disagree");
        params[name] = name === "limit" ? Number(value) : value;
      }
    } else {
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new QoopiaError("SIZE_LIMIT", "Request exceeds 4 MiB");
      const body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new QoopiaError("INVALID_INPUT", "Object body required");
      for (const [k, value] of Object.entries(params)) if (body[k] !== undefined && body[k] !== value) throw new QoopiaError("INVALID_INPUT", "Path and body identity disagree");
      params = { ...body, ...params };
      const headerKey = request.headers.get("idempotency-key"), match = request.headers.get("if-match")?.replace(/^"|"$/g, "");
      if (!headerKey || match === undefined) throw new QoopiaError("INVALID_INPUT", "Idempotency-Key and If-Match are required");
      if (params.idempotency_key !== undefined && params.idempotency_key !== headerKey) throw new QoopiaError("INVALID_INPUT", "Header and body idempotency keys disagree");
      params.idempotency_key = headerKey;
      const field = "expected_digest" in found.schema.shape ? "expected_digest" : "expected_revision";
      const expected = field === "expected_digest" ? match : Number(match);
      if (params[field] !== undefined && params[field] !== expected) throw new QoopiaError("INVALID_INPUT", "Header and body preconditions disagree");
      params[field] = expected;
    }
    const input = found.schema.parse(params);
    return Response.json(await found.handler(auth, input, database));
  } catch (error) {
    const result = apiError(error instanceof SyntaxError ? new QoopiaError("INVALID_INPUT", "Invalid JSON") : error);
    return Response.json({ error: result.error }, { status: result.status, headers: result.status === 429 ? { "retry-after": "60" } : {} });
  }
}

export function registerAuthorityTools(server: McpServer, authProvider: () => AuthContext | null, existingNames: Set<string>, database: Database = db) {
  server.registerTool("qoopia_capabilities", { description: "Read actual scoped operations, schemas, limits, effective config digest and the status of every Qoopia mechanism for this agent: available, forbidden, client_unsupported, needs_setup or faulty, with the reason and what to do. Steward and owner may pass agent (an id, an exact name, or \"all\") to see the same contract for other agents.",
    inputSchema: z.object({ agent: z.string().min(1).max(128).optional() }).strict() },
    async ({ agent }) => {
      try { return { content: [{ type: "text", text: JSON.stringify(agent ? agentCoverage(authProvider(), agent, database) : effectiveAuthority(authProvider() ?? undefined, database)) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify(apiError(error).error) }] }; }
    });
  for (const op of authorityOperations) {
    if (op.humanOnly || existingNames.has(op.name)) continue;
    const discoveryAuth = authProvider();
    if (discoveryAuth) { try { authorize(database, discoveryAuth, op.action); } catch { continue; } }
    server.registerTool(op.name, { description: op.description, inputSchema: op.schema }, async (args) => {
      try {
        const auth = authProvider();
        if (!auth) throw new QoopiaError("UNAUTHENTICATED", "Authentication required");
        return { content: [{ type: "text", text: JSON.stringify(await op.handler(auth, op.schema.parse(args), database)) }] };
      } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify(apiError(error).error) }] }; }
    });
  }
}
