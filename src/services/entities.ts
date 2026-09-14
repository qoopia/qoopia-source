import { autoEmbedEnabled } from "./embeddings.ts";
/**
 * Entity pages service — SoT for facts about persons, agents, machines,
 * services, projects, protocols, incidents, skills, and free-form
 * knowledge topics (Phase 2 Item C; migrations 021-022).
 *
 * Plan note: 01KSC0E9F1WFWJMSP58KS34H2A §"Item C — Entity pages MVP".
 * Preflight: 01KSCWHV14J0YHJV310YDXRGFP.
 *
 * Workspace boundary: every read and write is scoped to a single
 * `workspace_id`. The MCP layer pins this from auth context — service
 * callers must pass it explicitly.
 *
 * Failure model: argument errors throw `QoopiaError` with a stable
 * code (INVALID_INPUT, NOT_FOUND, CONFLICT). Constraint violations
 * from SQLite (UNIQUE on slug, CHECK on self-loop) bubble up as
 * QoopiaError too — the MCP fail() helper translates them.
 */
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, safeJsonParse } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { upsertEntityEmbedding } from "./embedding-store.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { legacySkillUpsert } from "../skills/compatibility.ts";

const MAX_TITLE = 300;
const MAX_SUMMARY = 100_000;
const MAX_SLUG = 200;
const RENDER_BODY_CAP = 32 * 1024; // 32 KiB — preflight self-review §"body cap"

export const ENTITY_TYPES = [
  "person",
  "agent",
  "machine",
  "service",
  "project",
  "protocol",
  "incident",
  "skill",
  "knowledge",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_STATUSES = ["active", "archived", "deprecated"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

/**
 * Reserved relation vocabulary. Free-form strings are accepted at the
 * service boundary (relation_type is plain TEXT) — this set is the
 * documented vocabulary for the first wave of entities and is what
 * recall, the orphan sweeper, and renderers know how to handle. New
 * relation types are added here, not via a migration.
 */
export const RESERVED_RELATIONS = new Set([
  "participants",
  "depends_on",
  "supersedes",
  "related_to",
  "documents",
  "triggers",
]);



function fireAndForgetEmbed(
  entity_id: string,
  workspace_id: string,
  title: string,
  summary: string | null,
  slug: string,
): void {
  if (!autoEmbedEnabled()) return;
  const text = `${title}\n\n${summary ?? ""}\n\nslug:${slug}`;
  upsertEntityEmbedding(entity_id, workspace_id, text).catch(() => {
    /* logged inside upsertEntityEmbedding */
  });
}

function msIso(): string {
  // Ms-precision ISO — matches migration 017's strftime('%Y-...%fZ')
  // convention so a JS-written updated_at sorts correctly against rows
  // written by the SQL DEFAULT.
  return new Date().toISOString();
}

function isValidSlug(slug: string): boolean {
  // Lowercase URL-safe ids: letters, digits, dash, underscore. No
  // leading/trailing dash. Length bound on the caller.
  return /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(slug);
}

export interface EntityRow {
  id: string;
  workspace_id: string;
  type: string;
  slug: string;
  title: string;
  summary: string | null;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface Entity {
  id: string;
  workspace_id: string;
  type: EntityType;
  slug: string;
  title: string;
  summary: string | null;
  status: EntityStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function toEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    type: r.type as EntityType,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    status: r.status as EntityStatus,
    metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface UpsertInput {
  expected_revision?: number;
  idempotency_key?: string;
  workspace_id: string;
  type: EntityType;
  slug: string;
  title: string;
  summary?: string | null;
  status?: EntityStatus;
  metadata?: Record<string, unknown>;
}

export interface UpsertResult {
  revision?: number;
  draft_id?: string;
  id: string;
  created: boolean;
  slug: string;
  type: EntityType;
  workspace_id: string;
  updated_at: string;
}

/**
 * Insert a new entity, or update the existing one keyed by
 * (workspace_id, slug). Idempotent: re-running with identical input
 * touches updated_at but is otherwise a no-op (caller cannot
 * distinguish from the initial create at the row level; the response
 * `created` flag tells them).
 */
export function upsertEntity(input: UpsertInput, auth?: AuthContext): UpsertResult {
  if (input.type === "skill") return legacySkillUpsert(input, auth);
  const oldKind = db.query("SELECT type FROM entity_pages WHERE workspace_id=? AND slug=?")
    .get(input.workspace_id, input.slug) as { type: string } | null;
  if (oldKind?.type === "skill") throw new QoopiaError("FORBIDDEN", "A skill identity cannot be retyped by entity_upsert");
  if (!input.workspace_id) {
    throw new QoopiaError("INVALID_INPUT", "workspace_id is required");
  }
  if (!ENTITY_TYPES.includes(input.type)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `type must be one of ${ENTITY_TYPES.join(", ")}`,
    );
  }
  if (!input.slug || input.slug.length > MAX_SLUG || !isValidSlug(input.slug)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "slug must be url-safe (a-z, 0-9, dash, underscore) and ≤ 200 chars",
    );
  }
  if (!input.title || input.title.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "title is required");
  }
  if (input.title.length > MAX_TITLE) {
    throw new QoopiaError("SIZE_LIMIT", `title exceeds ${MAX_TITLE} chars`);
  }
  if (input.summary && input.summary.length > MAX_SUMMARY) {
    throw new QoopiaError(
      "SIZE_LIMIT",
      `summary exceeds ${MAX_SUMMARY} chars — split into linked entities`,
    );
  }
  if (input.status && !ENTITY_STATUSES.includes(input.status)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `status must be one of ${ENTITY_STATUSES.join(", ")}`,
    );
  }

  assertNoSecrets(input.title, "entity.title");
  if (input.summary) assertNoSecrets(input.summary, "entity.summary");
  if (input.metadata) {
    assertNoSecrets(JSON.stringify(input.metadata), "entity.metadata");
  }

  const status = input.status ?? "active";
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const now = msIso();

  const existing = db
    .prepare(
      `SELECT id FROM entity_pages WHERE workspace_id = ? AND slug = ? LIMIT 1`,
    )
    .get(input.workspace_id, input.slug) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE entity_pages
         SET type = ?, title = ?, summary = ?, status = ?, metadata = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.type,
      input.title,
      input.summary ?? null,
      status,
      metadataJson,
      now,
      existing.id,
    );
    fireAndForgetEmbed(
      existing.id,
      input.workspace_id,
      input.title,
      input.summary ?? null,
      input.slug,
    );
    return {
      id: existing.id,
      created: false,
      slug: input.slug,
      type: input.type,
      workspace_id: input.workspace_id,
      updated_at: now,
    };
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO entity_pages
       (id, workspace_id, type, slug, title, summary, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.type,
    input.slug,
    input.title,
    input.summary ?? null,
    status,
    metadataJson,
    now,
    now,
  );
  fireAndForgetEmbed(
    id,
    input.workspace_id,
    input.title,
    input.summary ?? null,
    input.slug,
  );
  return {
    id,
    created: true,
    slug: input.slug,
    type: input.type,
    workspace_id: input.workspace_id,
    updated_at: now,
  };
}

export interface GetParams {
  workspace_id: string;
  id?: string;
  slug?: string;
}

export function getEntity(p: GetParams): Entity {
  if (!p.workspace_id) {
    throw new QoopiaError("INVALID_INPUT", "workspace_id is required");
  }
  if (!p.id && !p.slug) {
    throw new QoopiaError("INVALID_INPUT", "id or slug is required");
  }
  const row = p.id
    ? (db
        .prepare(
          `SELECT * FROM entity_pages WHERE id = ? AND workspace_id = ? AND authority_private=0 LIMIT 1`,
        )
        .get(p.id, p.workspace_id) as EntityRow | undefined)
    : (db
        .prepare(
          `SELECT * FROM entity_pages WHERE slug = ? AND workspace_id = ? AND authority_private=0 LIMIT 1`,
        )
        .get(p.slug!, p.workspace_id) as EntityRow | undefined);
  if (!row) {
    throw new QoopiaError(
      "NOT_FOUND",
      `entity ${p.id ?? p.slug} not found in workspace`,
    );
  }
  return toEntity(row);
}

export interface SearchParams {
  workspace_id: string;
  type?: EntityType;
  query?: string;
  status?: EntityStatus;
  limit?: number;
}

export interface SearchHit {
  id: string;
  workspace_id: string;
  type: EntityType;
  slug: string;
  title: string;
  summary_preview: string;
  status: EntityStatus;
  rank?: number;
}

const SUMMARY_PREVIEW_CHARS = 240;

function makePreview(s: string | null): string {
  if (!s) return "";
  if (s.length <= SUMMARY_PREVIEW_CHARS) return s;
  return s.slice(0, SUMMARY_PREVIEW_CHARS - 1) + "…";
}

/**
 * Sanitize a free-text query into an FTS5 MATCH expression. Mirrors the
 * sanitizer in recall.ts (sanitizeFtsQuery) for entity_pages_fts so callers
 * get the same operator-stripping and OR-default behaviour.
 *
 * CRITICAL: each term is wrapped as a double-quoted FTS5 string literal with a
 * prefix match (`"term"*`). The quoting is what neutralises FTS5
 * metacharacters — hyphens, colons, parens, and column/NEAR syntax — inside a
 * term. The previous implementation emitted BARE tokens, so a hyphenated query
 * such as "phase3-item-a-step1-smoke" reached MATCH unquoted and FTS5 parsed a
 * fragment as a column reference, raising SQLiteError "no such column: item"
 * (PHASE3_HYGIENE_FTS5_SANITIZE_BUG). Quoting fixes this for all callers
 * (skill_search, entity_search, and the recall entity channel via this path).
 *
 * Returns "" when there are no usable terms; the caller maps "" -> [].
 */
function ftsSanitize(q: string): string {
  const cleaned = q
    .replace(/["`]/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !/^(AND|OR|NOT|NEAR)$/i.test(t))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

export function searchEntities(p: SearchParams): SearchHit[] {
  if (!p.workspace_id) {
    throw new QoopiaError("INVALID_INPUT", "workspace_id is required");
  }
  if (p.type && !ENTITY_TYPES.includes(p.type)) {
    throw new QoopiaError("INVALID_INPUT", "unknown entity type");
  }
  if (p.status && !ENTITY_STATUSES.includes(p.status)) {
    throw new QoopiaError("INVALID_INPUT", "unknown entity status");
  }
  const limit = Math.min(Math.max(p.limit ?? 25, 1), 100);
  const status = p.status ?? "active";

  if (p.query && p.query.trim().length > 0) {
    const sanitized = ftsSanitize(p.query);
    if (!sanitized) return [];
    const where: string[] = [
      `entity_pages_fts MATCH ?`,
      `e.workspace_id = ?`,
      `e.status = ?`,
      `e.authority_private=0`,
    ];
    const params: any[] = [sanitized, p.workspace_id, status];
    if (p.type) {
      where.push(`e.type = ?`);
      params.push(p.type);
    }
    const sql = `
      SELECT e.id, e.workspace_id, e.type, e.slug, e.title, e.summary, e.status, rank
        FROM entity_pages_fts f
        JOIN entity_pages e ON e.rowid = f.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY rank
       LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit) as Array<
      EntityRow & { rank: number }
    >;
    return rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspace_id,
      type: r.type as EntityType,
      slug: r.slug,
      title: r.title,
      summary_preview: makePreview(r.summary),
      status: r.status as EntityStatus,
      rank: r.rank,
    }));
  }

  const where: string[] = [`workspace_id = ?`, `status = ?`, `authority_private=0`];
  const params: any[] = [p.workspace_id, status];
  if (p.type) {
    where.push(`type = ?`);
    params.push(p.type);
  }
  const rows = db
    .prepare(
      `SELECT * FROM entity_pages WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as EntityRow[];
  return rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    type: r.type as EntityType,
    slug: r.slug,
    title: r.title,
    summary_preview: makePreview(r.summary),
    status: r.status as EntityStatus,
  }));
}

export interface LinkInput {
  workspace_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  confidence?: number;
  source?: string;
}

export interface LinkResult {
  link_id: number | null;
  inserted: boolean;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
}

/**
 * Insert a directed link. Idempotent on (source, target, relation_type):
 * a duplicate triple is a silent no-op (`inserted=false`).
 *
 * Both endpoints MUST exist in the caller's workspace — the service
 * checks both rows in the same workspace_id before insert. This is
 * deliberately stricter than the DB schema (which has no FK) so cross-
 * workspace link smuggling is impossible from the MCP surface.
 */
export function addLink(input: LinkInput): LinkResult {
  if (!input.workspace_id) {
    throw new QoopiaError("INVALID_INPUT", "workspace_id is required");
  }
  if (!input.source_entity_id || !input.target_entity_id) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "source_entity_id and target_entity_id are required",
    );
  }
  if (input.source_entity_id === input.target_entity_id) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "self-loop forbidden: source_entity_id must differ from target_entity_id",
    );
  }
  if (!input.relation_type || input.relation_type.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "relation_type is required");
  }
  if (input.relation_type.length > 80) {
    throw new QoopiaError("SIZE_LIMIT", "relation_type exceeds 80 chars");
  }
  if (
    input.confidence !== undefined &&
    (input.confidence < 0 || input.confidence > 1)
  ) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "confidence must be in [0, 1]",
    );
  }

  const endpoints = db
    .prepare(
      `SELECT id FROM entity_pages
        WHERE id IN (?, ?) AND workspace_id = ?`,
    )
    .all(
      input.source_entity_id,
      input.target_entity_id,
      input.workspace_id,
    ) as Array<{ id: string }>;
  const found = new Set(endpoints.map((r) => r.id));
  if (!found.has(input.source_entity_id)) {
    throw new QoopiaError(
      "NOT_FOUND",
      `source entity ${input.source_entity_id} not found in workspace`,
    );
  }
  if (!found.has(input.target_entity_id)) {
    throw new QoopiaError(
      "NOT_FOUND",
      `target entity ${input.target_entity_id} not found in workspace`,
    );
  }

  // INSERT OR IGNORE on the UNIQUE triple → duplicate triples are no-op.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO entity_links
         (source_entity_id, target_entity_id, relation_type, confidence, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.source_entity_id,
      input.target_entity_id,
      input.relation_type,
      input.confidence ?? 1.0,
      input.source ?? null,
    );

  if (result.changes === 0) {
    // Duplicate triple — look up the existing row id.
    const existing = db
      .prepare(
        `SELECT id FROM entity_links
          WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
          LIMIT 1`,
      )
      .get(
        input.source_entity_id,
        input.target_entity_id,
        input.relation_type,
      ) as { id: number } | undefined;
    return {
      link_id: existing?.id ?? null,
      inserted: false,
      source_entity_id: input.source_entity_id,
      target_entity_id: input.target_entity_id,
      relation_type: input.relation_type,
    };
  }

  return {
    link_id: Number(result.lastInsertRowid),
    inserted: true,
    source_entity_id: input.source_entity_id,
    target_entity_id: input.target_entity_id,
    relation_type: input.relation_type,
  };
}

export interface RenderParams {
  workspace_id: string;
  id?: string;
  slug?: string;
}

export interface RenderResult {
  id: string;
  slug: string;
  type: EntityType;
  markdown: string;
  truncated: boolean;
}

/**
 * Render an entity as markdown with title, summary, metadata, and
 * inline link sections (outgoing and incoming). No raw secrets — body
 * is run through assertNoSecrets() before return.
 *
 * Hard cap: RENDER_BODY_CAP (32 KiB). Outputs above the cap are
 * truncated with a "(truncated; N bytes elided)" marker so the
 * MCP transport never carries pathological payloads.
 */
export function renderEntityPage(p: RenderParams): RenderResult {
  const ent = getEntity({
    workspace_id: p.workspace_id,
    id: p.id,
    slug: p.slug,
  });

  const outgoing = db
    .prepare(
      `SELECT l.relation_type, l.confidence, l.source,
              t.id AS target_id, t.slug AS target_slug, t.title AS target_title, t.type AS target_type
         FROM entity_links l
         JOIN (SELECT * FROM entity_pages WHERE authority_private=0) t
           ON t.id = l.target_entity_id AND t.workspace_id = ?
        WHERE l.source_entity_id = ?
        ORDER BY l.relation_type, t.slug`,
    )
    .all(ent.workspace_id, ent.id) as Array<{
    relation_type: string;
    confidence: number;
    source: string | null;
    target_id: string;
    target_slug: string;
    target_title: string;
    target_type: string;
  }>;

  const incoming = db
    .prepare(
      `SELECT l.relation_type, l.confidence, l.source,
              s.id AS source_id, s.slug AS source_slug, s.title AS source_title, s.type AS source_type
         FROM entity_links l
         JOIN (SELECT * FROM entity_pages WHERE authority_private=0) s
           ON s.id = l.source_entity_id AND s.workspace_id = ?
        WHERE l.target_entity_id = ?
        ORDER BY l.relation_type, s.slug`,
    )
    .all(ent.workspace_id, ent.id) as Array<{
    relation_type: string;
    confidence: number;
    source: string | null;
    source_id: string;
    source_slug: string;
    source_title: string;
    source_type: string;
  }>;

  const lines: string[] = [];
  lines.push(`# ${ent.title}`);
  lines.push("");
  lines.push(
    `*type:* \`${ent.type}\` &middot; *slug:* \`${ent.slug}\` &middot; *status:* \`${ent.status}\``,
  );
  lines.push(`*updated:* ${ent.updated_at}`);
  lines.push("");
  if (ent.summary) {
    lines.push(ent.summary);
    lines.push("");
  }
  if (Object.keys(ent.metadata).length > 0) {
    lines.push("## Metadata");
    lines.push("```json");
    lines.push(JSON.stringify(ent.metadata, null, 2));
    lines.push("```");
    lines.push("");
  }
  if (outgoing.length > 0) {
    lines.push("## Outgoing links");
    for (const o of outgoing) {
      lines.push(
        `- **${o.relation_type}** → \`${o.target_slug}\` (${o.target_type}) — ${o.target_title}`,
      );
    }
    lines.push("");
  }
  if (incoming.length > 0) {
    lines.push("## Incoming links");
    for (const i of incoming) {
      lines.push(
        `- \`${i.source_slug}\` (${i.source_type}) — ${i.source_title} — **${i.relation_type}** →`,
      );
    }
    lines.push("");
  }

  let markdown = lines.join("\n");
  let truncated = false;
  if (markdown.length > RENDER_BODY_CAP) {
    const elided = markdown.length - RENDER_BODY_CAP;
    markdown =
      markdown.slice(0, RENDER_BODY_CAP) +
      `\n\n_(truncated; ${elided} bytes elided)_\n`;
    truncated = true;
  }

  assertNoSecrets(markdown, "entity.render");

  return {
    id: ent.id,
    slug: ent.slug,
    type: ent.type,
    markdown,
    truncated,
  };
}

/**
 * List outgoing or incoming links — exposed for tests and the future
 * orphan sweeper. MCP surface uses renderEntityPage which embeds both.
 */
export function listLinks(
  workspace_id: string,
  entity_id: string,
  direction: "outgoing" | "incoming",
): Array<{
  relation_type: string;
  confidence: number;
  source: string | null;
  other_id: string;
  other_slug: string;
  other_title: string;
  other_type: string;
}> {
  const sql =
    direction === "outgoing"
      ? `SELECT l.relation_type, l.confidence, l.source,
                t.id AS other_id, t.slug AS other_slug, t.title AS other_title, t.type AS other_type
           FROM entity_links l
           JOIN (SELECT * FROM entity_pages WHERE authority_private=0) t
             ON t.id = l.target_entity_id AND t.workspace_id = ?
          WHERE l.source_entity_id = ?
          ORDER BY l.relation_type, t.slug`
      : `SELECT l.relation_type, l.confidence, l.source,
                s.id AS other_id, s.slug AS other_slug, s.title AS other_title, s.type AS other_type
           FROM entity_links l
           JOIN (SELECT * FROM entity_pages WHERE authority_private=0) s
             ON s.id = l.source_entity_id AND s.workspace_id = ?
          WHERE l.target_entity_id = ?
          ORDER BY l.relation_type, s.slug`;
  return db.prepare(sql).all(workspace_id, entity_id) as Array<{
    relation_type: string;
    confidence: number;
    source: string | null;
    other_id: string;
    other_slug: string;
    other_title: string;
    other_type: string;
  }>;
}
