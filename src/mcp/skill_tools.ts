/**
 * Fat skills MCP surface — Phase 2 Item E (plan note
 * 01KSC0E9F1WFWJMSP58KS34H2A §"Item E"). Five tools layered on top of
 * src/services/skills.ts. Registration is gated behind
 * QOOPIA_SKILLS=true in src/mcp/tools.ts (default OFF — mirrors the
 * QOOPIA_ENTITY_PAGES rollout pattern from Item C R2).
 *
 * Risk classification (QSA-F / ADR-016):
 *  - skill_upsert        write-low (idempotent on workspace+slug)
 *  - skill_get           read
 *  - skill_search        read
 *  - skill_render_runbook read
 *  - skill_mark_tested   write-low (only touches last_tested + tester_agent)
 *
 * Workspace boundary: every tool pins workspace_id from auth context;
 * the helper layer also runs assertNoSecrets() on title, summary,
 * metadata, and the rendered runbook so a skill update cannot smuggle
 * a credential into a public-ish surface.
 */
import { z } from "zod";
import type { AuthContext } from "../auth/middleware.ts";
import type { RiskClass } from "./tools.ts";
import {
  skillUpsert,
  skillGet,
  skillSearch,
  skillRenderRunbook,
  skillMarkTested,
  type SkillMetadata,
} from "../services/skills.ts";
import { ENTITY_STATUSES } from "../services/entities.ts";

export interface SkillToolDef {
  name: string;
  description: string;
  risk: RiskClass;
  rawSchema: z.ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    auth: AuthContext,
  ) => unknown | Promise<unknown>;
}

const entityStatusEnum = z.enum(ENTITY_STATUSES);

// Reused schemas — the helper layer does the full validation, so the
// Zod schemas here only need to cover the shape that the MCP transport
// is responsible for (presence + primitive types). Field-level
// constraints (non-empty string arrays, max-step caps) are enforced by
// validateSkillMetadata inside skillUpsert; rejecting them via Zod
// would duplicate the rules in two places that could drift.
const skillMetadataSchema = z
  .object({
    skill_version: z.string(),
    owner_agent: z.string(),
    trigger_conditions: z.array(z.string()),
    scope: z.string(),
    prerequisites: z.array(z.string()),
    exact_steps: z.array(z.string()),
    verification_gates: z.array(z.string()),
    failure_modes: z.array(z.string()),
    rollback: z.string(),
    related_code_paths: z.array(z.string()),
    related_incidents: z.array(z.string()),
    last_tested: z.string().optional(),
    tester_agent: z.string().optional(),
  })
  .strict();

export const skillTools: SkillToolDef[] = [
  {
    name: "skill_upsert",
    risk: "write-low",
    description:
      "Compatibility: create an immutable draft revision from a legacy runbook. Requires expected_revision and idempotency_key; the workspace comes from authentication. Sealed bytes are never overwritten.",
    rawSchema: {
      expected_revision: z.number().int().nonnegative(),
      idempotency_key: z.string().min(1).max(128),
      slug: z
        .string()
        .min(1)
        .max(200)
        .describe("URL-safe slug; UNIQUE per workspace."),
      title: z.string().min(1).max(300),
      summary: z
        .string()
        .min(1)
        .describe("Required for skills — renders as the runbook intro."),
      status: entityStatusEnum.optional().describe("Default 'active'."),
      metadata: skillMetadataSchema.describe(
        "Required skill metadata. See SKILL_METADATA_REQUIRED in src/services/skills.ts.",
      ),
    },
    handler: (args, auth) =>
      skillUpsert({
        expected_revision: args.expected_revision as number,
        idempotency_key: args.idempotency_key as string,
        workspace_id: auth.workspace_id,
        slug: String(args.slug),
        title: String(args.title),
        summary: String(args.summary),
        status: args.status as (typeof ENTITY_STATUSES)[number] | undefined,
        metadata: args.metadata as SkillMetadata,
      }, auth),
  },
  {
    name: "skill_get",
    risk: "read",
    description:
      "Fetch a skill entity by id or slug (Phase 2 Item E). Throws NOT_FOUND if the entity exists but is a different type. Workspace-scoped.",
    rawSchema: {
      id: z.string().optional(),
      slug: z.string().optional(),
    },
    handler: (args, auth) =>
      skillGet({
        workspace_id: auth.workspace_id,
        id: args.id as string | undefined,
        slug: args.slug as string | undefined,
      }),
  },
  {
    name: "skill_search",
    risk: "read",
    description:
      "Search skill entities (Phase 2 Item E). Pins type='skill' so the caller cannot accidentally widen across entity types. With `query`, FTS5 on entity_pages_fts; without, lists by status. Returns title + 240-char summary preview.",
    rawSchema: {
      query: z.string().max(1000).optional(),
      status: entityStatusEnum.optional().describe("Default 'active'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Default 25, capped at 100."),
    },
    handler: (args, auth) =>
      skillSearch({
        workspace_id: auth.workspace_id,
        query: args.query as string | undefined,
        status: args.status as (typeof ENTITY_STATUSES)[number] | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "skill_render_runbook",
    risk: "read",
    description:
      "Render a skill as an actionable markdown runbook (Phase 2 Item E). Sections: Trigger, Prerequisites, Steps, Verification, Failure modes, Rollback, Code paths, Related incidents. Operators paste the output into a session log when they run the skill.",
    rawSchema: {
      id: z.string().optional(),
      slug: z.string().optional(),
    },
    handler: (args, auth) =>
      skillRenderRunbook({
        workspace_id: auth.workspace_id,
        id: args.id as string | undefined,
        slug: args.slug as string | undefined,
      }),
  },
  {
    name: "skill_mark_tested",
    risk: "write-low",
    description:
      "Record a self-reported test event for the exact draft revision. The authenticated principal is the reporter. This does not create independent verification or change sealed bytes.",
    rawSchema: {
      expected_revision: z.number().int().min(1),
      idempotency_key: z.string().min(1).max(128),
      id: z.string().optional(),
      slug: z.string().optional(),
      tested_at: z
        .string()
        .describe("ISO timestamp reported by the authenticated tester."),
      tester_agent: z
        .string()
        .min(1)
        .describe("Authenticated reporter ID or name; another principal is forbidden."),
    },
    handler: (args, auth) =>
      skillMarkTested({
        expected_revision: args.expected_revision as number,
        idempotency_key: args.idempotency_key as string,
        workspace_id: auth.workspace_id,
        id: args.id as string | undefined,
        slug: args.slug as string | undefined,
        tested_at: String(args.tested_at),
        tester_agent: String(args.tester_agent),
      }, auth),
  },
];
