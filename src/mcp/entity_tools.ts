/**
 * Entity page MCP tools — Phase 2 Item C (plan note
 * 01KSC0E9F1WFWJMSP58KS34H2A, preflight 01KSCWHV14J0YHJV310YDXRGFP).
 *
 * Five tools registered alongside notes/sessions surface:
 *  - entity_upsert      (write-low; idempotent on workspace+slug)
 *  - entity_get         (read; id-or-slug lookup, workspace-scoped)
 *  - entity_search      (read; FTS5 query or type/status filter listing)
 *  - entity_link        (write-low; idempotent triple, self-loops forbidden)
 *  - entity_page_render (read; markdown rendering with linked sections)
 *
 * Workspace boundary is pinned from auth — callers cannot cross
 * workspaces. Cross-workspace surfacing is reserved for the privileged
 * recall path which already gates on `auth.type === 'claude-privileged'`.
 *
 * Risk classification (QSA-F / ADR-016): the two writers are
 * `write-low` (idempotent and recoverable via re-upsert / explicit
 * delete tooling — there is no entity_delete in MVP); the three
 * readers are `read`.
 */
import { z } from "zod";
import type { AuthContext } from "../auth/middleware.ts";
import type { RiskClass } from "./tools.ts";
import {
  upsertEntity,
  getEntity,
  searchEntities,
  addLink,
  renderEntityPage,
  ENTITY_TYPES,
  ENTITY_STATUSES,
} from "../services/entities.ts";

export interface EntityToolDef {
  name: string;
  description: string;
  risk: RiskClass;
  rawSchema: z.ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    auth: AuthContext,
  ) => unknown | Promise<unknown>;
}

const entityTypeEnum = z.enum(ENTITY_TYPES);
const entityStatusEnum = z.enum(ENTITY_STATUSES);

export const entityTools: EntityToolDef[] = [
  {
    name: "entity_upsert",
    risk: "write-low",
    description:
      "Insert or update a canonical entity page (Phase 2 Item C). Idempotent on (workspace, slug). type ∈ person/agent/machine/service/project/protocol/incident/skill/knowledge. Workspace pinned from auth.",
    rawSchema: {
      expected_revision: z.number().int().nonnegative().optional(),
      idempotency_key: z.string().min(1).max(128).optional(),
      type: entityTypeEnum,
      slug: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "URL-safe id, lowercase letters/digits/-/_; UNIQUE per workspace.",
        ),
      title: z.string().min(1).max(300),
      summary: z.string().max(100_000).optional(),
      status: entityStatusEnum.optional().describe("Default 'active'."),
      metadata: z.record(z.unknown()).optional(),
    },
    handler: (args, auth) =>
      upsertEntity({
        expected_revision: args.expected_revision as number | undefined,
        idempotency_key: args.idempotency_key as string | undefined,
        workspace_id: auth.workspace_id,
        type: args.type as (typeof ENTITY_TYPES)[number],
        slug: String(args.slug),
        title: String(args.title),
        summary: (args.summary as string | undefined) ?? null,
        status: args.status as (typeof ENTITY_STATUSES)[number] | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
      }, auth),
  },
  {
    name: "entity_get",
    risk: "read",
    description:
      "Fetch a canonical entity page by id or slug (Phase 2 Item C). Workspace-scoped.",
    rawSchema: {
      id: z.string().optional(),
      slug: z.string().optional(),
    },
    handler: (args, auth) => {
      const id = args.id as string | undefined;
      const slug = args.slug as string | undefined;
      return getEntity({ workspace_id: auth.workspace_id, id, slug });
    },
  },
  {
    name: "entity_search",
    risk: "read",
    description:
      "Search entity pages (Phase 2 Item C). With `query`, runs FTS5 on entity_pages_fts. Without, lists by type/status. Returns title + truncated 240-char summary preview.",
    rawSchema: {
      query: z.string().max(1000).optional(),
      type: entityTypeEnum.optional(),
      status: entityStatusEnum.optional().describe("Default 'active'."),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: (args, auth) =>
      searchEntities({
        workspace_id: auth.workspace_id,
        query: args.query as string | undefined,
        type: args.type as (typeof ENTITY_TYPES)[number] | undefined,
        status: args.status as (typeof ENTITY_STATUSES)[number] | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "entity_link",
    risk: "write-low",
    description:
      "Add a directed link between two entities in the same workspace (Phase 2 Item C). Idempotent on (source, target, relation_type). Self-loops forbidden. Reserved relations: participants, depends_on, supersedes, related_to, documents, triggers (free-form strings accepted; vocabulary lives in services/entities.ts).",
    rawSchema: {
      source_entity_id: z.string().min(1),
      target_entity_id: z.string().min(1),
      relation_type: z.string().min(1).max(80),
      confidence: z.number().min(0).max(1).optional(),
      source: z.string().max(200).optional(),
    },
    handler: (args, auth) =>
      addLink({
        workspace_id: auth.workspace_id,
        source_entity_id: String(args.source_entity_id),
        target_entity_id: String(args.target_entity_id),
        relation_type: String(args.relation_type),
        confidence: args.confidence as number | undefined,
        source: args.source as string | undefined,
      }),
  },
  {
    name: "entity_page_render",
    risk: "read",
    description:
      "Render an entity page as markdown with title, summary, metadata, and inline outgoing/incoming link sections (Phase 2 Item C). Body capped at 32 KiB; secrets are detected and refused via assertNoSecrets.",
    rawSchema: {
      id: z.string().optional(),
      slug: z.string().optional(),
    },
    handler: (args, auth) =>
      renderEntityPage({
        workspace_id: auth.workspace_id,
        id: args.id as string | undefined,
        slug: args.slug as string | undefined,
      }),
  },
];
