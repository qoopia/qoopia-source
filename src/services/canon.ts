/**
 * Canon: short rules the owner and the agents keep, loaded into an agent's context by the server
 * itself — brief and session start carry the `always` ones, every user turn (memory hook) and
 * every AgentComm wake carry the `contextual` ones its triggers, words and meaning pick — so a
 * rule no longer depends on a prompt remembering to ask for it.
 *
 * One canon belongs to the whole workspace, one agent or one project. A changed rule supersedes
 * the old one; at most one version of a rule is active. canon_applications records each delivery,
 * so "the canon was never loaded" and "it was loaded and not followed" can be told apart.
 */
import { ulid } from "ulid";
import { z } from "zod";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { logger } from "../utils/logger.ts";
import { logActivity } from "./activity.ts";
import { analyzeFtsQuery, buildFtsMatch, russianStem } from "./fts-query.ts";
import { assertAutomaticMemoryAllowed } from "./memory-policy.ts";
import { ADMIN_TYPES, isDreamer, readLevel, visibleRowSql } from "../auth/principal.ts";

export const CANON_MAX_CHARS = 2000;
export const CANON_SCOPES = ["workspace", "agent", "project"] as const;
export const CANON_MODES = ["always", "contextual"] as const;
export type CanonScope = (typeof CANON_SCOPES)[number];
export type CanonMode = (typeof CANON_MODES)[number];
export type CanonSurface = "session_start" | "prompt" | "brief" | "wake" | "match";
export type CanonSource = "manual" | "rule_import" | "dreaming" | "dashboard";
export interface CanonTriggers { words: string[]; projects: string[]; tools: string[]; files: string[] }

/** Selection budgets: a canon block must never crowd out the conversation it serves. */
const ALWAYS_MAX = 12, ALWAYS_CHARS = 6000, CONTEXTUAL_MAX = 5, CONTEXTUAL_CHARS = 4000, MIN_SCORE = 2;
/** Similarity of two rule texts (shared significant stems) above which a new canon is the same rule. */
const SAME_RULE = 0.8, RELATED_RULE = 0.35;
/** ponytail: one fixed cosine floor for the semantic channel, tuned for multilingual-e5-small;
 * measure against real turns and move it to config if another embedder is used. */
const SEMANTIC_FLOOR = Number(process.env.QOOPIA_CANON_SEMANTIC_MIN) || 0.84;
const SEMANTIC_TIMEOUT_MS = 1200;
const APPLICATION_RETENTION_DAYS = 90;

interface CanonRow {
  id: string; workspace_id: string; scope: CanonScope; agent_id: string | null; project_id: string | null;
  text: string; mode: CanonMode; triggers: string; status: "active" | "superseded" | "retired";
  supersedes_id: string | null; superseded_by: string | null; source: CanonSource; source_note_id: string | null;
  created_by: string | null; created_at: string; updated_at: string; last_applied_at: string | null; applied_count: number;
}
export interface Actor { agent_id: string; type: string }

const STOPWORDS = new Set((
  "the and for with that this from have will your you are not but all any can into when what which there their them then than " +
  "also only must should always never use using each other more most some such very just about after before over under " +
  "это как что для при или его она они оно все всё был была были быть если когда только также чтобы надо нужно можно нельзя " +
  "всегда никогда очень есть нет без над под про через после перед того этот эта эти тот там тут где кто ещё уже так"
).split(" "));

/** Significant word stems of a text, in order of first appearance. */
export function stems(text: string, max = 400): string[] {
  const seen = new Set<string>(), out: string[] = [];
  // FTS terms keep punctuation ("коротко,"); a stem is letters and digits only.
  for (const term of analyzeFtsQuery(text.slice(0, 8000)).terms.flatMap((t) => t.split(/[^\p{L}\p{N}]+/u))) {
    if ([...term].length < 3 || STOPWORDS.has(term) || /^\d+$/.test(term)) continue;
    const stem = russianStem(term);
    if (!seen.has(stem)) { seen.add(stem); out.push(stem); if (out.length >= max) break; }
  }
  return out;
}

/** Shared significant stems over the smaller rule: 1 for the same rule reworded slightly. */
export function ruleSimilarity(a: string, b: string): number {
  const x = new Set(stems(a)), y = new Set(stems(b));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const s of x) if (y.has(s)) shared++;
  return shared / Math.min(x.size, y.size);
}

const FILE_TOKEN = /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w-]+\.(?:md|json|toml|ya?ml|ts|js|py|sql|sh|plist|env|txt|html|css))(?=$|[\s"'`),.;:])/gi;
const TOOL_TOKEN = /\b([a-z]+_[a-z_]+)\b|\b(git|docker|ssh|bun|npm|gh|sqlite3|systemctl|launchctl|curl|rsync)\b/g;

/** Triggers a rule's own text suggests: its most specific words, the files and tools it names. */
export function suggestTriggers(text: string): CanonTriggers {
  const files = [...new Set([...text.matchAll(FILE_TOKEN)].map((m) => m[1]!.toLowerCase()))].slice(0, 6);
  const tools = [...new Set([...text.toLowerCase().matchAll(TOOL_TOKEN)].map((m) => m[1] ?? m[2]!))].slice(0, 6);
  // Longer words are the more specific ones; ties keep the text's own order.
  const words = stems(text).map((s, i) => ({ s, i })).sort((a, b) => b.s.length - a.s.length || a.i - b.i).slice(0, 8).map((w) => w.s);
  return { words, projects: [], tools, files };
}

function cleanList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase().slice(0, 120)).filter(Boolean))].slice(0, max);
}
export function normalizeTriggers(input: unknown): CanonTriggers {
  const t = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return { words: cleanList(t.words, 20), projects: cleanList(t.projects, 10), tools: cleanList(t.tools, 10), files: cleanList(t.files, 10) };
}
const emptyTriggers = (t: CanonTriggers) => !t.words.length && !t.projects.length && !t.tools.length && !t.files.length;

const isAdmin = (actor: Actor) => ADMIN_TYPES.has(actor.type);

/** The steward, the owner and the dreamer read every canon of the workspace. */
function readsAll(actor: Actor, database = db): boolean {
  return isAdmin(actor) || isDreamer(actor.agent_id, database);
}

/** A project note the agent may read (the canon of a project follows its project's visibility). */
const projectReadable = (alias: string) =>
  `EXISTS (SELECT 1 FROM notes p WHERE p.id = ${alias}.project_id AND p.deleted_at IS NULL AND ${visibleRowSql("p")})`;

/** Canons the agent may see. Binds: (agent, agent, level). */
function readableSql(alias = "c"): string {
  return `(${alias}.scope = 'workspace' OR (${alias}.scope = 'agent' AND ${alias}.agent_id = ?) OR (${alias}.scope = 'project' AND ${projectReadable(alias)}))`;
}
/** Canons that apply to this agent's own turns — what it is held to, not what it may read. Binds as readableSql. */
const applicableSql = readableSql;

function resolveAgent(workspace: string, ref: string): { id: string; name: string } {
  const row = db.query("SELECT id, name FROM agents WHERE workspace_id = ? AND active = 1 AND (id = ? OR lower(name) = lower(?))").get(workspace, ref, ref) as { id: string; name: string } | null;
  if (!row) throw new QoopiaError("NOT_FOUND", `agent '${ref}' not found in this workspace`);
  return row;
}
function resolveProject(workspace: string, ref: string, actor: Actor): { id: string; name: string } {
  const level = readLevel(actor.agent_id, readsAll(actor));
  const row = db.query(`SELECT id, text FROM notes WHERE workspace_id = ? AND type = 'project' AND deleted_at IS NULL AND (id = ? OR text = ?) AND ${visibleRowSql()} LIMIT 1`)
    .get(workspace, ref, ref, actor.agent_id, level) as { id: string; text: string } | null;
  if (!row) throw new QoopiaError("NOT_FOUND", `project '${ref}' not found in this workspace`);
  return { id: row.id, name: row.text.split("\n")[0]!.slice(0, 120) };
}

/** Workspace and project canons bind every agent: only the steward and the owner write them. An
 * agent writes its own canons. */
function assertMayWrite(actor: Actor, scope: CanonScope, agentId: string | null): void {
  if (isAdmin(actor)) return;
  if (scope === "agent" && agentId === actor.agent_id) return;
  throw new QoopiaError("FORBIDDEN", scope === "agent"
    ? "Another agent's canon is changed by that agent, the steward or the owner."
    : "A workspace or project canon binds every agent: the steward or the owner sets it. Keep it as your own canon (scope 'agent') or ask the steward.",
    { next_action: "Ask the steward or the owner, or use scope 'agent'." });
}

function rowById(workspace: string, id: string, actor: Actor): CanonRow {
  const row = db.query(`SELECT c.* FROM canons c WHERE c.workspace_id = ? AND c.id = ?`).get(workspace, id) as CanonRow | null;
  if (!row || !canRead(row, actor)) throw new QoopiaError("NOT_FOUND", `canon ${id} not found`);
  return row;
}
function canRead(row: CanonRow, actor: Actor): boolean {
  if (readsAll(actor)) return true;
  if (row.scope === "workspace") return true;
  if (row.scope === "agent") return row.agent_id === actor.agent_id;
  const level = readLevel(actor.agent_id, false);
  return !!db.query(`SELECT 1 FROM notes p WHERE p.id = ? AND p.deleted_at IS NULL AND ${visibleRowSql("p")}`).get(row.project_id, actor.agent_id, level);
}

export function publicCanon(row: CanonRow) {
  return {
    id: row.id, scope: row.scope, agent_id: row.agent_id, project_id: row.project_id, text: row.text, mode: row.mode,
    triggers: normalizeTriggers(safeJsonParse(row.triggers, {})), status: row.status, supersedes_id: row.supersedes_id,
    superseded_by: row.superseded_by, source: row.source, source_note_id: row.source_note_id, created_by: row.created_by,
    created_at: row.created_at, updated_at: row.updated_at, last_applied_at: row.last_applied_at, applied_count: row.applied_count,
  };
}
export type PublicCanon = ReturnType<typeof publicCanon>;

/** Active canons with the same holder (scope and target) as the new one, most similar first. */
function similarActive(workspace: string, scope: CanonScope, agentId: string | null, projectId: string | null, text: string, except?: string) {
  const rows = db.query(`SELECT * FROM canons WHERE workspace_id = ? AND status = 'active' AND scope = ?
    AND agent_id IS ? AND project_id IS ?`).all(workspace, scope, agentId, projectId) as CanonRow[];
  return rows.filter((r) => r.id !== except).map((r) => ({ row: r, similarity: ruleSimilarity(text, r.text) }))
    .filter((r) => r.similarity >= RELATED_RULE).sort((a, b) => b.similarity - a.similarity);
}

export interface CreateCanonInput {
  workspace_id: string; actor: Actor; text: string; scope?: CanonScope; agent?: string; project?: string; mode?: CanonMode;
  triggers?: unknown; supersedes_id?: string; on_conflict?: "ask" | "replace" | "keep_both"; source?: CanonSource;
  source_note_id?: string; created_at?: string;
}

/**
 * "This is canon" in one call. The agent words the rule; the server suggests triggers when none
 * were given, looks for the same holder's older canon on the same subject and replaces it, so two
 * contradicting rules are never active together:
 *  - the same rule reworded (≥ 0.8 of its significant words shared) is replaced at once;
 *  - a related rule (≥ 0.35) is not guessed at: the call answers CONFLICT with the candidates and
 *    the agent repeats it with supersedes_id, or on_conflict 'keep_both' / 'replace'.
 */
export function createCanon(input: CreateCanonInput) {
  const { workspace_id: workspace, actor } = input;
  const text = input.text.trim();
  if (!text) throw new QoopiaError("INVALID_INPUT", "canon text is empty");
  if (text.length > CANON_MAX_CHARS) throw new QoopiaError("SIZE_LIMIT", `a canon holds at most ${CANON_MAX_CHARS} characters; keep one short rule per canon`);
  assertNoSecrets(text, "canon.text");
  const source = input.source ?? "manual";
  // A canon is memory the agent writes: in "save only on request" it waits for the owner, like a skill.
  if (source === "manual") assertAutomaticMemoryAllowed(workspace, actor.agent_id);

  let superseded: CanonRow | null = input.supersedes_id ? rowById(workspace, input.supersedes_id, actor) : null;
  if (superseded && superseded.status !== "active") throw new QoopiaError("CONFLICT", `canon ${superseded.id} is already ${superseded.status}; supersede its current version ${superseded.superseded_by ?? ""}`.trim());

  let scope: CanonScope = input.scope ?? superseded?.scope ?? (input.project ? "project" : isAdmin(actor) && !input.agent ? "workspace" : "agent");
  let agentId: string | null = null, projectId: string | null = null, projectName: string | null = null;
  if (scope === "agent") agentId = input.agent ? resolveAgent(workspace, input.agent).id : superseded?.scope === "agent" && !input.scope ? superseded.agent_id : actor.agent_id;
  if (scope === "project") {
    if (input.project) { const p = resolveProject(workspace, input.project, actor); projectId = p.id; projectName = p.name; }
    else if (superseded?.project_id) projectId = superseded.project_id;
    else throw new QoopiaError("INVALID_INPUT", "a project canon needs project (its id or exact name)");
  }
  assertMayWrite(actor, scope, agentId);
  if (superseded) assertMayWrite(actor, superseded.scope, superseded.agent_id);

  const given = normalizeTriggers(input.triggers);
  const suggested = suggestTriggers(text);
  const triggers = emptyTriggers(given) ? suggested : given;
  if (projectName && !triggers.projects.includes(projectName.toLowerCase())) triggers.projects.push(projectName.toLowerCase());
  const mode: CanonMode = input.mode ?? superseded?.mode ?? "contextual";

  const conflicts = superseded ? [] : similarActive(workspace, scope, agentId, projectId, text);
  if (!superseded && conflicts.length && input.on_conflict !== "keep_both") {
    const top = conflicts[0]!;
    if (top.similarity >= SAME_RULE || input.on_conflict === "replace") superseded = top.row;
    else throw new QoopiaError("CONFLICT", "A related canon is already active for this holder. Repeat with supersedes_id to replace it, or on_conflict 'keep_both' if both rules hold.", {
      candidates: conflicts.slice(0, 5).map((c) => ({ id: c.row.id, text: c.row.text, similarity: Math.round(c.similarity * 100) / 100 })),
      next_action: "Call canon_create again with supersedes_id (replace) or on_conflict 'keep_both'.",
    });
  }

  const id = ulid(), now = input.created_at ?? nowIso();
  db.transaction(() => {
    db.query(`INSERT INTO canons (id, workspace_id, scope, agent_id, project_id, text, mode, triggers, status, supersedes_id, source, source_note_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
      .run(id, workspace, scope, agentId, projectId, text, mode, JSON.stringify(triggers), superseded?.id ?? null, source, input.source_note_id ?? null, actor.agent_id, now, now);
    if (superseded) {
      // The old version is closed in the same transaction; a racing supersede of it changes nothing.
      // changes counts trigger writes too, so the row itself says whether this call closed it.
      db.query("UPDATE canons SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(id, now, superseded.id);
      const closed = db.query("SELECT superseded_by FROM canons WHERE id = ?").get(superseded.id) as { superseded_by: string | null } | null;
      if (closed?.superseded_by !== id) throw new QoopiaError("CONFLICT", `canon ${superseded.id} changed meanwhile; read it again`);
    }
    logActivity({ workspace_id: workspace, agent_id: actor.agent_id, action: superseded ? "canon_superseded" : "canon_created", entity_type: "canon", entity_id: id,
      project_id: projectId, summary: superseded ? `Canon ${superseded.id} superseded by ${id}` : `Canon ${id} created`,
      details: { event: superseded ? "canon.superseded" : "canon.created", params: { canon_id: id, scope, mode, ...(superseded ? { superseded_id: superseded.id } : {}) } },
      visibility: scope === "agent" ? "private" : "workspace" });
  }).immediate();
  void embedCanon(id, workspace, text);
  const row = db.query("SELECT * FROM canons WHERE id = ?").get(id) as CanonRow;
  return { canon: publicCanon(row), ...(superseded ? { replaced: superseded.id } : {}), suggested_triggers: suggested,
    ...(conflicts.length && input.on_conflict === "keep_both" ? { kept_alongside: conflicts.map((c) => c.row.id) } : {}) };
}

/** A new wording supersedes (the history keeps the old one); mode and triggers change in place. */
export function updateCanon(p: { workspace_id: string; actor: Actor; id: string; text?: string; mode?: CanonMode; triggers?: unknown }) {
  const row = rowById(p.workspace_id, p.id, p.actor);
  assertMayWrite(p.actor, row.scope, row.agent_id);
  if (row.status !== "active") throw new QoopiaError("CONFLICT", `canon ${row.id} is ${row.status}; change its current version ${row.superseded_by ?? ""}`.trim());
  if (p.text !== undefined && p.text.trim() !== row.text)
    return createCanon({ workspace_id: p.workspace_id, actor: p.actor, text: p.text, supersedes_id: row.id, mode: p.mode,
      triggers: p.triggers ?? safeJsonParse(row.triggers, {}), source: row.source === "rule_import" ? "manual" : row.source });
  assertAutomaticMemoryAllowed(p.workspace_id, p.actor.agent_id);
  const triggers = p.triggers === undefined ? row.triggers : JSON.stringify(normalizeTriggers(p.triggers));
  db.query("UPDATE canons SET mode = ?, triggers = ?, updated_at = ? WHERE id = ?").run(p.mode ?? row.mode, triggers, nowIso(), row.id);
  return { canon: publicCanon(db.query("SELECT * FROM canons WHERE id = ?").get(row.id) as CanonRow) };
}

export function retireCanon(p: { workspace_id: string; actor: Actor; id: string; reason?: string }) {
  const row = rowById(p.workspace_id, p.id, p.actor);
  assertMayWrite(p.actor, row.scope, row.agent_id);
  if (row.status !== "active") throw new QoopiaError("CONFLICT", `canon ${row.id} is already ${row.status}`);
  const reason = (p.reason ?? "").trim().slice(0, 500);
  if (reason) assertNoSecrets(reason, "canon.reason");
  db.transaction(() => {
    db.query("UPDATE canons SET status = 'retired', updated_at = ? WHERE id = ? AND status = 'active'").run(nowIso(), row.id);
    logActivity({ workspace_id: p.workspace_id, agent_id: p.actor.agent_id, action: "canon_retired", entity_type: "canon", entity_id: row.id,
      project_id: row.project_id, summary: `Canon ${row.id} retired`, details: { event: "canon.retired", params: { canon_id: row.id, ...(reason ? { reason } : {}) } },
      visibility: row.scope === "agent" ? "private" : "workspace" });
  }).immediate();
  return { canon: publicCanon(db.query("SELECT * FROM canons WHERE id = ?").get(row.id) as CanonRow) };
}

export function getCanon(p: { workspace_id: string; actor: Actor; id: string }) {
  const row = rowById(p.workspace_id, p.id, p.actor);
  const history: PublicCanon[] = [];
  for (let prev = row.supersedes_id, guard = 0; prev && guard < 50; guard++) {
    const older = db.query("SELECT * FROM canons WHERE id = ?").get(prev) as CanonRow | null;
    if (!older) break;
    history.push(publicCanon(older)); prev = older.supersedes_id;
  }
  const applications = db.query(`SELECT a.agent_id, ag.name AS agent_name, a.session_id, a.surface, a.reason, a.applied_at FROM canon_applications a
    LEFT JOIN agents ag ON ag.id = a.agent_id WHERE a.canon_id = ? ORDER BY a.applied_at DESC LIMIT 20`).all(row.id);
  return { canon: publicCanon(row), history, applications };
}

export function listCanons(p: { workspace_id: string; actor: Actor; agent?: string; scope?: CanonScope; status?: "active" | "superseded" | "retired" | "all"; query?: string; limit?: number }) {
  const all = readsAll(p.actor), level = readLevel(p.actor.agent_id, all);
  const where = ["c.workspace_id = ?"], params: (string | number)[] = [p.workspace_id];
  if (!all) { where.push(readableSql()); params.push(p.actor.agent_id, p.actor.agent_id, level); }
  if (p.status !== "all") { where.push("c.status = ?"); params.push(p.status ?? "active"); }
  if (p.scope) { where.push("c.scope = ?"); params.push(p.scope); }
  if (p.agent) {
    // An agent's canon set: its own canons and the ones every agent keeps.
    const agent = resolveAgent(p.workspace_id, p.agent);
    where.push("(c.scope != 'agent' OR c.agent_id = ?)"); params.push(agent.id);
  }
  const match = p.query ? buildFtsMatch(p.query) : "";
  if (p.query && !match) return { total: 0, items: [] };
  if (match) { where.push("c.rowid IN (SELECT rowid FROM canons_fts WHERE canons_fts MATCH ?)"); params.push(match); }
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const rows = db.query(`SELECT c.* FROM canons c WHERE ${where.join(" AND ")} ORDER BY c.scope = 'workspace' DESC, c.mode = 'always' DESC, c.updated_at DESC LIMIT ?`)
    .all(...params, limit) as CanonRow[];
  const total = (db.query(`SELECT COUNT(*) AS n FROM canons c WHERE ${where.join(" AND ")}`).get(...params) as { n: number }).n;
  return { total, items: rows.map(publicCanon) };
}

// ---------------------------------------------------------------- selection

export interface MatchContext {
  workspace_id: string; agent_id: string; prompt?: string; cwd?: string; project?: string; files?: string[]; tools?: string[];
  surface: CanonSurface; session_id?: string; record?: boolean; include_always?: boolean; include_contextual?: boolean;
}
export interface MatchedCanon { canon: PublicCanon; score: number; reasons: string[] }

function wordHit(trigger: string, tokens: Set<string>, haystack: string): boolean {
  const parts = trigger.split(/\s+/).filter(Boolean);
  if (parts.length > 1 || /[^\p{L}\p{N}]/u.test(trigger)) return haystack.includes(trigger);
  const stem = russianStem(trigger);
  if (tokens.has(stem)) return true;
  for (const t of tokens) if (stem.length >= 4 && t.startsWith(stem)) return true;
  return false;
}

/** Contextual canons the turn's own words, project and named files and tools point at. Pure, so
 * the logic is tested without a model; the semantic score is passed in. */
export function scoreCanon(row: Pick<CanonRow, "text" | "triggers" | "project_id">, ctx: { text: string; tokens: Set<string>; places: string[]; projectId?: string | null }, semantic = 0) {
  const t = normalizeTriggers(safeJsonParse(row.triggers, {}));
  let score = 0; const reasons: string[] = [];
  for (const w of t.words) if (wordHit(w, ctx.tokens, ctx.text)) { score += 2; reasons.push(`word:${w}`); }
  for (const f of t.files) if (ctx.text.includes(f) || ctx.places.some((p) => p.includes(f))) { score += 2; reasons.push(`file:${f}`); }
  for (const tool of t.tools) if (wordHit(tool, ctx.tokens, ctx.text)) { score += 2; reasons.push(`tool:${tool}`); }
  for (const pr of t.projects) if (ctx.text.includes(pr) || ctx.places.some((p) => p.split(/[\\/]/).includes(pr))) { score += 3; reasons.push(`project:${pr}`); }
  if (row.project_id && ctx.projectId === row.project_id) { score += 3; reasons.push("project"); }
  // Lexical overlap with the rule itself, beyond its declared triggers.
  let shared = 0;
  for (const s of stems(row.text)) if (ctx.tokens.has(s)) shared++;
  if (shared >= 2) { score += Math.min(3, shared - 1); reasons.push(`text:${shared}`); }
  if (semantic >= SEMANTIC_FLOOR) { const add = Math.min(3, ((semantic - SEMANTIC_FLOOR) / (1 - SEMANTIC_FLOOR)) * 4); score += add; reasons.push(`meaning:${semantic.toFixed(2)}`); }
  return { score, reasons };
}

async function semanticScores(workspace: string, ids: string[], prompt: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length || !prompt.trim()) return out;
  try {
    const { EMBED_MODEL, embedText, deserializeEmbedding, cosineSim, autoEmbedEnabled } = await import("./embeddings.ts");
    if (!autoEmbedEnabled()) return out;
    const rows = db.query(`SELECT canon_id, embedding FROM canon_embeddings WHERE workspace_id = ? AND model = ?`).all(workspace, EMBED_MODEL) as { canon_id: string; embedding: Buffer }[];
    const wanted = new Set(ids), present = rows.filter((r) => wanted.has(r.canon_id));
    if (!present.length) return out;
    // A slow embedder must not hold a user's turn: the lexical channels already answered.
    const query = await Promise.race([embedText(prompt.slice(0, 4000)), new Promise<null>((r) => setTimeout(() => r(null), SEMANTIC_TIMEOUT_MS).unref?.())]);
    if (!query) return out;
    for (const r of present) { const sim = cosineSim(query, deserializeEmbedding(r.embedding)); if (Number.isFinite(sim)) out.set(r.canon_id, sim); }
  } catch (error) { logger.warn(`canon semantic channel skipped: ${error instanceof Error ? error.message : String(error)}`); }
  return out;
}

export async function embedCanon(id: string, workspace: string, text: string): Promise<void> {
  try {
    const { EMBED_MODEL, EMBED_DIM, EMBED_PROVIDER, embedText, serializeEmbedding, textHash, autoEmbedEnabled } = await import("./embeddings.ts");
    if (!autoEmbedEnabled()) return;
    const hash = textHash(text);
    const existing = db.query("SELECT text_hash, model FROM canon_embeddings WHERE canon_id = ?").get(id) as { text_hash: string; model: string } | null;
    if (existing?.text_hash === hash && existing.model === EMBED_MODEL) return;
    // A passage vector for the rule, a query vector for the turn (e5 is asymmetric).
    const vec = EMBED_PROVIDER === "builtin" ? (await (await import("./builtin-embeddings.ts")).embedBuiltin(text))[0]!.vector : await embedText(text);
    if (!db.query("SELECT 1 FROM canons WHERE id = ? AND text = ?").get(id, text)) return;
    db.query(`INSERT INTO canon_embeddings (canon_id, workspace_id, embedding, dim, model, text_hash) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(canon_id) DO UPDATE SET embedding = excluded.embedding, dim = excluded.dim, model = excluded.model, text_hash = excluded.text_hash`)
      .run(id, workspace, serializeEmbedding(vec), EMBED_DIM, EMBED_MODEL, hash);
  } catch (error) { logger.warn(`canon ${id} embedding skipped: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Active canons without a current vector, for the maintenance backfill. */
export async function embedPendingCanons(limit = 16): Promise<number> {
  const { EMBED_MODEL, autoEmbedEnabled } = await import("./embeddings.ts");
  if (!autoEmbedEnabled()) return 0;
  const rows = db.query(`SELECT c.id, c.workspace_id, c.text FROM canons c LEFT JOIN canon_embeddings e ON e.canon_id = c.id AND e.model = ?
    WHERE c.status = 'active' AND e.canon_id IS NULL LIMIT ?`).all(EMBED_MODEL, limit) as { id: string; workspace_id: string; text: string }[];
  for (const r of rows) await embedCanon(r.id, r.workspace_id, r.text);
  return rows.length;
}

function budget(items: MatchedCanon[], max: number, chars: number): MatchedCanon[] {
  const out: MatchedCanon[] = []; let used = 0;
  for (const item of items) {
    if (out.length >= max) break;
    if (used + item.canon.text.length > chars && out.length) continue;
    out.push(item); used += item.canon.text.length;
  }
  return out;
}

function applicableRows(workspace: string, agentId: string): CanonRow[] {
  return db.query(`SELECT c.* FROM canons c WHERE c.workspace_id = ? AND c.status = 'active' AND ${applicableSql()}`)
    .all(workspace, agentId, agentId, readLevel(agentId, false)) as CanonRow[];
}

/**
 * The canons that apply to one agent's turn. `always` canons of the workspace and the agent come
 * first (a project's always canons only while that project is in play); then the contextual ones
 * whose score reaches MIN_SCORE, at most five, within a character budget. Synchronous: the
 * semantic channel's scores are passed in (matchCanons computes them).
 */
export function selectCanons(ctx: MatchContext, semantic: Map<string, number> = new Map()): { always: MatchedCanon[]; contextual: MatchedCanon[] } {
  const rows = applicableRows(ctx.workspace_id, ctx.agent_id);
  if (!rows.length) return { always: [], contextual: [] };
  const prompt = (ctx.prompt ?? "").slice(0, 8000);
  const text = prompt.toLowerCase();
  const places = [ctx.cwd, ...(ctx.files ?? [])].filter((v): v is string => !!v).map((v) => v.toLowerCase());
  const tokens = new Set([...stems(prompt, 2000), ...(ctx.tools ?? []).map((t) => t.toLowerCase())]);
  let projectId: string | null = null;
  if (ctx.project) try { projectId = resolveProject(ctx.workspace_id, ctx.project, { agent_id: ctx.agent_id, type: "agent" }).id; } catch { projectId = null; }
  const turn = { text, tokens, places, projectId };
  const inPlay = (r: CanonRow) => r.scope !== "project" || r.project_id === projectId || scoreCanon(r, turn).reasons.some((x) => x.startsWith("project"));
  // Scope order: the agent's own rule is the most specific, then its project's, then the workspace's.
  const rank = (r: CanonRow) => (r.scope === "agent" ? 0 : r.scope === "project" ? 1 : 2);

  const always = ctx.include_always === false ? [] : budget(rows.filter((r) => r.mode === "always" && inPlay(r))
    .sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at))
    .map((r) => ({ canon: publicCanon(r), score: 0, reasons: ["always"] })), ALWAYS_MAX, ALWAYS_CHARS);

  let contextual: MatchedCanon[] = [];
  if (ctx.include_contextual !== false && (prompt.trim() || places.length || projectId)) {
    contextual = budget(rows.filter((r) => r.mode === "contextual" && inPlay(r)).map((r) => { const s = scoreCanon(r, turn, semantic.get(r.id) ?? 0); return { row: r, ...s }; })
      .filter((m) => m.score >= MIN_SCORE).sort((a, b) => b.score - a.score || rank(a.row) - rank(b.row))
      .map((m) => ({ canon: publicCanon(m.row), score: Math.round(m.score * 100) / 100, reasons: m.reasons })), CONTEXTUAL_MAX, CONTEXTUAL_CHARS);
  }
  if (ctx.record !== false) recordApplications(ctx, [...always, ...contextual]);
  return { always, contextual };
}

/** selectCanons with the semantic channel: the turn's meaning against each contextual canon. */
export async function matchCanons(ctx: MatchContext): Promise<{ always: MatchedCanon[]; contextual: MatchedCanon[] }> {
  const prompt = (ctx.prompt ?? "").trim();
  const semantic = prompt && ctx.include_contextual !== false
    ? await semanticScores(ctx.workspace_id, applicableRows(ctx.workspace_id, ctx.agent_id).filter((r) => r.mode === "contextual").map((r) => r.id), prompt)
    : new Map<string, number>();
  return selectCanons(ctx, semantic);
}

/** Which canons reached which turn. Old rows go after APPLICATION_RETENTION_DAYS. */
export function recordApplications(ctx: Pick<MatchContext, "workspace_id" | "agent_id" | "session_id" | "surface">, items: MatchedCanon[]): void {
  if (!items.length) return;
  const now = nowIso();
  try {
    db.transaction(() => {
      const insert = db.query("INSERT INTO canon_applications (workspace_id, canon_id, agent_id, session_id, surface, reason, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const touch = db.query("UPDATE canons SET last_applied_at = ?, applied_count = applied_count + 1 WHERE id = ?");
      for (const item of items) { insert.run(ctx.workspace_id, item.canon.id, ctx.agent_id, ctx.session_id?.slice(0, 200) ?? null, ctx.surface, item.reasons.join(",").slice(0, 500), now); touch.run(now, item.canon.id); }
    }).immediate();
  } catch (error) {
    // The journal is evidence, not the delivery: a busy database must not cost the agent its canon.
    logger.warn(`canon application log skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function pruneCanonApplications(now = Date.now()): number {
  const cut = new Date(now - APPLICATION_RETENTION_DAYS * 86_400_000).toISOString();
  return db.query("DELETE FROM canon_applications WHERE applied_at < ?").run(cut).changes;
}

/** The block a hook, brief or wake puts in front of the agent. Empty when nothing applies. */
export function renderCanon(match: { always: MatchedCanon[]; contextual: MatchedCanon[] }, heading = "Qoopia canon"): string {
  const items = [...match.always, ...match.contextual];
  if (!items.length) return "";
  const line = (m: MatchedCanon) => `- ${m.canon.text.replace(/\s*\n\s*/g, " ")} [canon ${m.canon.id}${m.canon.mode === "always" ? ", always" : ""}]`;
  return `${heading}: rules the owner and this agent keep. Follow them unless the user's current message says otherwise; ` +
    `name the canon id when one decides what you do.\n${items.map(line).join("\n")}\n`;
}

// ---------------------------------------------------------------- rule import

export interface ImportPlanItem { note_id: string; action: "import" | "skip"; reason: string; scope?: CanonScope; agent_id?: string | null; project_id?: string | null; mode?: CanonMode; canon_id?: string }

/**
 * Rule notes (type 'rule') become canons by a fixed, repeatable procedure — no model and no owner
 * click decides anything here:
 *  1. Only current rules: not deleted, not superseded (invalidated), not archived.
 *  2. A rule already imported (its note id is a canon's source) is skipped: a rerun adds nothing.
 *  3. Longer than CANON_MAX_CHARS, holding a secret, or the same text as an active canon of the
 *     same holder: skipped with that reason.
 *  4. Holder: the rule's project when it has one; the workspace when it is tagged canon:workspace
 *     (and is not private) or was written by the human owner; otherwise the agent that wrote it.
 *     A rule whose author agent is gone is skipped.
 *  5. Mode: always when tagged `always` or `canon:always`, otherwise contextual.
 *  6. Triggers: the rule's tags (without canon:*), its subject key and the words of its own text.
 * Without commit it only reports the plan. With commit every planned canon is written in one
 * transaction, and the rule notes themselves stay unchanged.
 */
export function importRuleCanons(p: { workspace_id: string; commit?: boolean; actor_agent_id?: string }) {
  const notes = db.query(`SELECT n.id, n.agent_id, n.text, n.tags, n.project_id, n.visibility, n.subject_key, a.active AS author_active,
      (SELECT 1 FROM workspace_owners o WHERE o.workspace_id = n.workspace_id AND o.actor_id = n.agent_id) AS by_owner
    FROM notes n LEFT JOIN agents a ON a.id = n.agent_id
    WHERE n.workspace_id = ? AND n.type = 'rule' AND n.deleted_at IS NULL AND n.invalidated_at_ms IS NULL
      AND (json_extract(n.metadata, '$.status') IS NULL OR json_extract(n.metadata, '$.status') != 'archived')
    ORDER BY n.created_at, n.id`).all(p.workspace_id) as Array<{ id: string; agent_id: string | null; text: string; tags: string; project_id: string | null; visibility: string; subject_key: string | null; author_active: number | null; by_owner: number | null }>;
  const imported = new Set((db.query("SELECT source_note_id FROM canons WHERE workspace_id = ? AND source_note_id IS NOT NULL").all(p.workspace_id) as { source_note_id: string }[]).map((r) => r.source_note_id));
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const holderKey = (scope: CanonScope, a: string | null, pr: string | null) => `${scope}|${a ?? ""}|${pr ?? ""}`;
  const existing = new Set((db.query("SELECT scope, agent_id, project_id, text FROM canons WHERE workspace_id = ? AND status = 'active'").all(p.workspace_id) as CanonRow[])
    .map((r) => holderKey(r.scope, r.agent_id, r.project_id) + "|" + norm(r.text)));
  const plan: ImportPlanItem[] = [];
  const writes: Array<{ item: ImportPlanItem; text: string; triggers: CanonTriggers; created_by: string | null }> = [];
  for (const n of notes) {
    const skip = (reason: string) => plan.push({ note_id: n.id, action: "skip", reason });
    if (imported.has(n.id)) { skip("already_imported"); continue; }
    const text = n.text.trim();
    if (!text) { skip("empty"); continue; }
    if (text.length > CANON_MAX_CHARS) { skip("too_long"); continue; }
    try { assertNoSecrets(text, "canon.text"); } catch { skip("contains_secret"); continue; }
    const tags = safeJsonParse<unknown[]>(n.tags, []).filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const project = n.project_id ? db.query("SELECT id, text FROM notes WHERE id = ? AND type = 'project' AND deleted_at IS NULL").get(n.project_id) as { id: string; text: string } | null : null;
    let scope: CanonScope, agentId: string | null = null, projectId: string | null = null;
    if (project) { scope = "project"; projectId = project.id; }
    else if (n.visibility !== "private" && (tags.includes("canon:workspace") || n.by_owner)) scope = "workspace";
    else { if (!n.agent_id || !n.author_active) { skip("author_inactive"); continue; } scope = "agent"; agentId = n.agent_id; }
    const key = holderKey(scope, agentId, projectId) + "|" + norm(text);
    if (existing.has(key)) { skip("duplicate_text"); continue; }
    existing.add(key);
    const mode: CanonMode = tags.includes("always") || tags.includes("canon:always") ? "always" : "contextual";
    const own = suggestTriggers(text);
    const subject = n.subject_key ? n.subject_key.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3) : [];
    const triggers: CanonTriggers = { words: [...new Set([...tags.filter((t) => !t.startsWith("canon:") && t !== "always"), ...subject, ...own.words])].slice(0, 20),
      projects: project ? [project.text.split("\n")[0]!.slice(0, 120).toLowerCase()] : [], tools: own.tools, files: own.files };
    const item: ImportPlanItem = { note_id: n.id, action: "import", reason: scope === "project" ? "project_rule" : scope === "workspace" ? (n.by_owner ? "owner_rule" : "tagged_workspace") : "agent_rule", scope, agent_id: agentId, project_id: projectId, mode };
    plan.push(item); writes.push({ item, text, triggers, created_by: n.agent_id });
  }
  if (p.commit && writes.length) {
    const now = nowIso();
    db.transaction(() => {
      const insert = db.query(`INSERT INTO canons (id, workspace_id, scope, agent_id, project_id, text, mode, triggers, status, source, source_note_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'rule_import', ?, ?, ?, ?)`);
      for (const w of writes) {
        const id = ulid(); w.item.canon_id = id;
        insert.run(id, p.workspace_id, w.item.scope!, w.item.agent_id ?? null, w.item.project_id ?? null, w.text, w.item.mode!, JSON.stringify(w.triggers), w.item.note_id, w.created_by, now, now);
      }
      logActivity({ workspace_id: p.workspace_id, agent_id: p.actor_agent_id ?? null, action: "canon_imported", entity_type: "canon", entity_id: null, project_id: null,
        summary: `Imported ${writes.length} rule notes as canons`, details: { event: "canon.imported", params: { count: writes.length } } });
    }).immediate();
    for (const w of writes) void embedCanon(w.item.canon_id!, p.workspace_id, w.text);
  }
  const count = (action: string, reason?: string) => plan.filter((i) => i.action === action && (!reason || i.reason === reason)).length;
  const reasons = [...new Set(plan.filter((i) => i.action === "skip").map((i) => i.reason))];
  return {
    committed: !!p.commit, rules: notes.length, import: count("import"),
    skipped: Object.fromEntries(reasons.map((r) => [r, count("skip", r)])), plan,
  };
}


const hookRequest = z.object({
  session_id: z.string().min(1).max(200).optional(),
  event: z.enum(["start", "prompt"]),
  prompt: z.string().max(8000).optional(),
  cwd: z.string().max(2048).optional(),
}).strict();

/** /memory/canon: what a memory hook puts in front of the agent. Session start carries the always
 * canons; each user prompt carries the contextual ones that turn calls for. */
export async function canonHookRequest(workspace: string, agent: string, raw: unknown) {
  const body = hookRequest.parse(raw);
  const start = body.event === "start";
  // A session whose start brought no always canons (a Codex Desktop thread registered by its first turn, a
  // start that timed out) gets them with its first prompt; the journal says whether they arrived.
  const always = start || (!!body.session_id && !db.query("SELECT 1 FROM canon_applications WHERE agent_id = ? AND session_id = ? AND reason = 'always' LIMIT 1")
    .get(agent, body.session_id.slice(0, 200)));
  const match = await matchCanons({ workspace_id: workspace, agent_id: agent, prompt: body.prompt, cwd: body.cwd, session_id: body.session_id,
    surface: start ? "session_start" : "prompt", include_always: always, include_contextual: !start });
  return { text: renderCanon(match), ids: [...match.always, ...match.contextual].map((m) => m.canon.id) };
}
