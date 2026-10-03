/**
 * Fat skills layer — typed convention on top of entity_pages
 * type='skill' (Phase 2 Item E; migration 023).
 *
 * Plan note: 01KSC0E9F1WFWJMSP58KS34H2A §"Item E — Fat skills layer".
 * Reuses entity_pages per Q-P2-5: no new table. The skills helpers
 * wrap upsertEntity / getEntity / searchEntities and add metadata
 * schema validation plus a markdown runbook renderer.
 *
 * Required metadata fields are enforced at write time by
 * skill_upsert. The shape mirrors migration 023's documentation
 * block — if you change one, change the other.
 */
import {
  upsertEntity,
  getEntity,
  searchEntities,
  type Entity,
  type EntityStatus,
  type SearchHit,
  type UpsertResult,
} from "./entities.ts";
import { QoopiaError } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { legacyMarkTested } from "../skills/compatibility.ts";
import { db } from "../db/connection.ts";
import { mdItem, mdLine, type SkillContent } from "../skills/format.ts";
import { skillReviewLine, skillReviewState, type SkillReviewState } from "../skills/authority.ts";

/**
 * Fields the skill_upsert caller MUST provide in metadata. Adding a
 * field here is non-breaking for read paths (skill_get still works
 * on older rows) but write paths will reject inputs missing the new
 * field — bump migration 023 if you add one.
 */
export const SKILL_METADATA_REQUIRED = [
  "skill_version",
  "owner_agent",
  "trigger_conditions",
  "scope",
  "prerequisites",
  "exact_steps",
  "verification_gates",
  "failure_modes",
  "rollback",
  "related_code_paths",
  "related_incidents",
] as const;

/** Fields whose value must be a non-empty string array. */
const STRING_ARRAY_FIELDS = new Set<string>([
  "trigger_conditions",
  "prerequisites",
  "exact_steps",
  "verification_gates",
  "failure_modes",
  "related_code_paths",
  "related_incidents",
]);

/** Fields whose value must be a non-empty string. */
const STRING_FIELDS = new Set<string>([
  "skill_version",
  "owner_agent",
  "scope",
  "rollback",
]);

const MAX_STEP_LEN = 4_000;
const MAX_STEP_COUNT = 100;

export interface SkillMetadata {
  skill_version: string;
  owner_agent: string;
  trigger_conditions: string[];
  scope: string;
  prerequisites: string[];
  exact_steps: string[];
  verification_gates: string[];
  failure_modes: string[];
  rollback: string;
  related_code_paths: string[];
  related_incidents: string[];
  last_tested?: string;
  tester_agent?: string;
  [key: string]: unknown;
}

interface SkillUpsertInput {
  expected_revision?: number;
  idempotency_key?: string;
  workspace_id: string;
  slug: string;
  title: string;
  summary: string;
  status?: EntityStatus;
  metadata: SkillMetadata;
}

/**
 * Validate skill metadata. Throws QoopiaError on first violation —
 * callers do not get partial saves. Validation is intentionally
 * strict: missing required field is a write-time failure, not a
 * silent default, because a half-encoded runbook is worse than no
 * runbook (it lies about being verified).
 */
export function validateSkillMetadata(metadata: unknown): void {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "skill metadata must be an object",
    );
  }
  const m = metadata as Record<string, unknown>;

  for (const field of SKILL_METADATA_REQUIRED) {
    if (!(field in m)) {
      throw new QoopiaError(
        "INVALID_INPUT",
        `skill metadata missing required field '${field}' (see SKILL_METADATA_REQUIRED)`,
      );
    }
  }

  for (const field of STRING_FIELDS) {
    const v = m[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new QoopiaError(
        "INVALID_INPUT",
        `skill metadata.${field} must be a non-empty string`,
      );
    }
  }

  for (const field of STRING_ARRAY_FIELDS) {
    const v = m[field];
    if (!Array.isArray(v)) {
      throw new QoopiaError(
        "INVALID_INPUT",
        `skill metadata.${field} must be an array of strings`,
      );
    }
    if (v.length === 0) {
      throw new QoopiaError(
        "INVALID_INPUT",
        `skill metadata.${field} must contain at least one entry`,
      );
    }
    if (v.length > MAX_STEP_COUNT) {
      throw new QoopiaError(
        "SIZE_LIMIT",
        `skill metadata.${field} exceeds ${MAX_STEP_COUNT} entries — split the skill`,
      );
    }
    for (let i = 0; i < v.length; i++) {
      const entry = v[i];
      if (typeof entry !== "string" || entry.length === 0) {
        throw new QoopiaError(
          "INVALID_INPUT",
          `skill metadata.${field}[${i}] must be a non-empty string`,
        );
      }
      if (entry.length > MAX_STEP_LEN) {
        throw new QoopiaError(
          "SIZE_LIMIT",
          `skill metadata.${field}[${i}] exceeds ${MAX_STEP_LEN} chars`,
        );
      }
    }
  }

  if (m.last_tested !== undefined) {
    if (typeof m.last_tested !== "string" || m.last_tested.length === 0) {
      throw new QoopiaError(
        "INVALID_INPUT",
        "skill metadata.last_tested must be an ISO timestamp string",
      );
    }
    const ts = Date.parse(m.last_tested);
    if (Number.isNaN(ts)) {
      throw new QoopiaError(
        "INVALID_INPUT",
        "skill metadata.last_tested must parse as an ISO timestamp",
      );
    }
  }
  if (m.tester_agent !== undefined) {
    if (typeof m.tester_agent !== "string" || m.tester_agent.length === 0) {
      throw new QoopiaError(
        "INVALID_INPUT",
        "skill metadata.tester_agent must be a non-empty string when set",
      );
    }
  }
}

/**
 * Upsert a skill entity. Wraps entity_upsert with type='skill' and
 * runs validateSkillMetadata first so the row is never written with
 * a malformed runbook.
 */
export function skillUpsert(input: SkillUpsertInput, auth?: AuthContext): UpsertResult {
  if (!input.summary || input.summary.length === 0) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "skill summary is required (renders as the runbook intro)",
    );
  }
  validateSkillMetadata(input.metadata);
  // Defensive: the entity layer also runs assertNoSecrets, but skills
  // carry exact_steps and verification_gates that are the most likely
  // place a secret would slip in. Check the joined steps explicitly so
  // the error pins the offending field rather than 'entity.metadata'.
  const stepsBlob = [
    ...(input.metadata.exact_steps ?? []),
    ...(input.metadata.verification_gates ?? []),
    ...(input.metadata.failure_modes ?? []),
    input.metadata.rollback ?? "",
  ].join("\n");
  assertNoSecrets(stepsBlob, "skill.steps");

  return upsertEntity({
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
    workspace_id: input.workspace_id,
    type: "skill",
    slug: input.slug,
    title: input.title,
    summary: input.summary,
    status: input.status,
    metadata: input.metadata,
  }, auth);
}

interface SkillGetParams {
  workspace_id: string;
  id?: string;
  slug?: string;
}

interface Skill extends Entity {
  metadata: SkillMetadata;
  /** Server-derived; never taken from the author's content. */
  review_state: SkillReviewState;
}

/**
 * Fetch a skill entity. Throws NOT_FOUND if the entity exists but is
 * not type='skill' — the caller asked for a skill, not a person who
 * happens to share a slug.
 */
export function skillGet(p: SkillGetParams): Skill {
  const ent = getEntity({
    workspace_id: p.workspace_id,
    id: p.id,
    slug: p.slug,
  });
  if (ent.type !== "skill") {
    throw new QoopiaError(
      "NOT_FOUND",
      `entity ${p.id ?? p.slug} exists but type='${ent.type}', not 'skill'`,
    );
  }
  const head = db.query(`SELECT r.content_json,r.legacy_runbook_json,r.actor_id,d.id AS draft_id,d.revision
    FROM skill_drafts d JOIN skill_draft_revisions r ON r.id=d.head_revision_id WHERE d.skill_id=? AND d.workspace_id=?`)
    .get(ent.id, p.workspace_id) as { content_json: string; legacy_runbook_json: string | null; actor_id: string; draft_id: string; revision: number } | null;
  const review_state = skillReviewState(db, p.workspace_id, ent.id);
  if (!head) return { ...ent, metadata: ent.metadata as SkillMetadata, review_state };
  const c = JSON.parse(head.content_json) as SkillContent;
  const original = head.legacy_runbook_json ? JSON.parse(head.legacy_runbook_json) : {};
  const last = db.query(`SELECT details_json FROM authority_events WHERE workspace_id=? AND subject_id=? AND kind='skill_test_self_reported' ORDER BY event_seq DESC LIMIT 1`)
    .get(p.workspace_id, ent.id) as { details_json: string } | null;
  const observation = last ? JSON.parse(last.details_json) : null;
  return { ...ent, review_state, metadata: { ...original.metadata,
    skill_version: original.metadata?.skill_version ?? `draft-${head.revision}`, owner_agent: head.actor_id,
    // Canonical content has no scope; keep the one a legacy writer supplied.
    trigger_conditions: c.trigger, scope: original.metadata?.scope ?? c.purpose, prerequisites: c.compatibility, exact_steps: c.procedure,
    verification_gates: c.verification, failure_modes: c.failure_modes, rollback: c.rollback,
    related_code_paths: original.metadata?.related_code_paths ?? [], related_incidents: original.metadata?.related_incidents ?? [],
    draft_id: head.draft_id, revision: head.revision,
    ...(observation ? { last_tested: observation.tested_at, tester_agent: observation.tester_agent, evidence_class: "self_reported" } : {}),
  } };
}

interface SkillSearchParams {
  workspace_id: string;
  query?: string;
  status?: EntityStatus;
  limit?: number;
}

/**
 * Search skill entities. Wraps entity_search with type='skill' pinned
 * so callers cannot accidentally widen the search across types.
 */
export function skillSearch(p: SkillSearchParams): Array<SearchHit & { review_state: SkillReviewState }> {
  return searchEntities({
    workspace_id: p.workspace_id,
    type: "skill",
    query: p.query,
    status: p.status,
    limit: p.limit,
  }).map((hit) => ({ ...hit, review_state: skillReviewState(db, p.workspace_id, hit.id) }));
}

interface SkillRunbook {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  last_tested: string | null;
}

/**
 * Render a skill as a markdown runbook. Sections:
 * Trigger, Prerequisites, Steps, Verification, Failure modes,
 * Rollback, Code paths, Related incidents, Metadata. Operators
 * paste the rendered runbook into a session log when they execute
 * the skill — so the rendered form must be self-contained, including
 * the server-written review line: an unsealed draft is reference data.
 */
export function skillRenderRunbook(p: SkillGetParams): SkillRunbook {
  const s = skillGet(p);
  const m = s.metadata;
  const r = s.review_state;
  const declared = r.state === "sealed" && !r.draft_newer_than_sealed ? "" : " (author-declared)";

  const lines: string[] = [];
  lines.push(`# ${mdLine(s.title)}`);
  lines.push("");
  lines.push(skillReviewLine(r));
  lines.push(
    `*skill_version:* \`${m.skill_version}\`${declared} &middot; *owner:* \`${m.owner_agent}\` &middot; *status:* \`${s.status}\``,
  );
  if (m.last_tested) {
    lines.push(
      `*last_tested:* ${m.last_tested}${m.tester_agent ? ` by \`${m.tester_agent}\`` : ""}`,
    );
    lines.push("*evidence:* self-reported; not independently verified");
  } else {
    lines.push(`*last_tested:* never`);
  }
  lines.push(mdItem("*scope:* ", m.scope, 0));
  lines.push("");
  if (s.summary) {
    lines.push(mdItem("", s.summary));
    lines.push("");
  }

  lines.push("## Trigger");
  for (const t of m.trigger_conditions) lines.push(mdItem("- ", t));
  lines.push("");

  lines.push("## Prerequisites");
  for (const p of m.prerequisites) lines.push(mdItem("- ", p));
  lines.push("");

  lines.push("## Steps");
  m.exact_steps.forEach((step, i) => {
    lines.push(mdItem(`${i + 1}. `, step));
  });
  lines.push("");

  lines.push("## Verification");
  for (const g of m.verification_gates) lines.push(mdItem("- [ ] ", g, 2));
  lines.push("");

  lines.push("## Failure modes");
  for (const f of m.failure_modes) lines.push(mdItem("- ", f));
  lines.push("");

  lines.push("## Rollback");
  lines.push(mdItem("", m.rollback));
  lines.push("");

  if (m.related_code_paths.length > 0) {
    lines.push("## Code paths");
    for (const cp of m.related_code_paths) lines.push(`- \`${mdLine(cp)}\``);
    lines.push("");
  }

  if (m.related_incidents.length > 0) {
    lines.push("## Related incidents");
    for (const inc of m.related_incidents) lines.push(mdItem("- ", inc));
    lines.push("");
  }

  const markdown = lines.join("\n");
  assertNoSecrets(markdown, "skill.runbook");

  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    markdown,
    last_tested: m.last_tested ?? null,
  };
}

interface SkillMarkTestedInput {
  expected_revision?: number;
  idempotency_key?: string;
  workspace_id: string;
  id?: string;
  slug?: string;
  tested_at: string;
  tester_agent: string;
}

/**
 * Mark a skill as verified at a point in time. Updates
 * metadata.last_tested and metadata.tester_agent via skillUpsert so
 * the validation path still runs on the merged metadata — the rest
 * of the runbook can't drift into an invalid state during a mark.
 */
export function skillMarkTested(input: SkillMarkTestedInput, auth?: AuthContext): UpsertResult {
  return legacyMarkTested(auth, input);
}
