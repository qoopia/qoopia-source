import { randomUUID } from "node:crypto";
import type { AuthContext } from "../auth/middleware.ts";
import { db } from "../db/connection.ts";
import { QoopiaError } from "../utils/errors.ts";
import { command } from "./commands.ts";
import { reviseDraft, draftOf, requireSkillRead } from "./authority.ts";
import { contentSchema } from "./format.ts";
import type { UpsertInput, UpsertResult } from "../services/entities.ts";

const fields = new Set(["skill_version", "owner_agent", "trigger_conditions", "scope", "prerequisites", "exact_steps",
  "verification_gates", "failure_modes", "rollback", "related_code_paths", "related_incidents", "last_tested", "tester_agent"]);

/** Legacy writers translate into the canonical revision command; no SQL skill writer lives here. */
export function legacySkillUpsert(input: UpsertInput, auth?: AuthContext): UpsertResult {
  if (!auth || auth.workspace_id !== input.workspace_id) throw new QoopiaError("UNAUTHENTICATED", "Skill writes require an authenticated principal");
  const m = input.metadata ?? {};
  if (Object.keys(m).some((f) => !fields.has(f))) throw new QoopiaError("INVALID_INPUT", "Unknown legacy skill metadata field; use structured skill_draft_revise");
  if (m.last_tested !== undefined || m.tester_agent !== undefined) throw new QoopiaError("INVALID_INPUT", "Use skill_mark_tested for an attributed self-report");
  const found = db.query(`SELECT e.id,d.id AS draft_id,d.revision FROM entity_pages e LEFT JOIN skill_drafts d ON d.skill_id=e.id
    WHERE e.workspace_id=? AND e.slug=?`).get(input.workspace_id, input.slug) as { id: string; draft_id: string | null; revision: number } | null;
  if (found && !found.draft_id) throw new QoopiaError("CONFLICT", "Existing identity requires explicit migration mapping before skill revision");
  if (found && input.expected_revision === undefined) throw new QoopiaError("INVALID_INPUT", "Existing skill requires expected_revision; reload its draft before editing");
  const content = contentSchema.parse({ title: input.title, purpose: input.summary ?? "", trigger: m.trigger_conditions ?? [],
    procedure: m.exact_steps ?? [], verification: m.verification_gates ?? [], failure_modes: m.failure_modes ?? [],
    rollback: m.rollback ?? "", compatibility: m.prerequisites ?? [] });
  const result = reviseDraft(auth, { slug: input.slug,
    expected_revision: input.expected_revision ?? 0, content,
    // Creates and edits both carry an explicit client retry key.
    idempotency_key: input.idempotency_key ?? (() => { throw new QoopiaError("INVALID_INPUT", "idempotency_key is required for legacy skill mutation"); })(),
  }, db, { title: input.title, summary: input.summary ?? null, status: input.status ?? "active", metadata: m });
  return { id: result.data.skill_id, created: result.revision === 1, slug: input.slug, type: "skill", workspace_id: auth.workspace_id,
    updated_at: new Date((db.query("SELECT updated_at_ms FROM skill_drafts WHERE id=?").get(result.data.draft_id) as { updated_at_ms: number }).updated_at_ms).toISOString(),
    revision: result.revision, draft_id: result.data.draft_id };
}

export function legacyMarkTested(auth: AuthContext | undefined, input: {
  workspace_id: string; id?: string; slug?: string; tested_at: string; tester_agent: string;
  expected_revision?: number; idempotency_key?: string;
}): UpsertResult {
  if (!auth || auth.workspace_id !== input.workspace_id) throw new QoopiaError("UNAUTHENTICATED", "Self-report requires authentication");
  if (input.tester_agent !== auth.agent_id && input.tester_agent !== auth.agent_name) throw new QoopiaError("FORBIDDEN", "tester_agent must identify the authenticated reporter");
  if (!Number.isFinite(Date.parse(input.tested_at))) throw new QoopiaError("INVALID_INPUT", "tested_at must be an ISO timestamp");
  if (!input.idempotency_key || input.expected_revision === undefined) throw new QoopiaError("INVALID_INPUT", "Self-report requires idempotency_key and expected_revision");
  const row = db.query(`SELECT d.id AS draft_id,d.skill_id,e.slug FROM skill_drafts d JOIN entity_pages e ON e.id=d.skill_id
    WHERE d.workspace_id=? AND (e.id=? OR e.slug=?)`).get(auth.workspace_id, input.id ?? null, input.slug ?? null) as { draft_id: string; skill_id: string; slug: string } | null;
  if (!row) throw new QoopiaError("NOT_FOUND", "Skill not found");
  const response = command(db, auth, "legacy-skill", "skill_mark_tested", input.idempotency_key,
    { skill_id: row.skill_id, tested_at: input.tested_at, expected_revision: input.expected_revision }, row.skill_id,
    (p) => { draftOf(db, p.workspace_id, row.draft_id); requireSkillRead(db, p, row.skill_id); }, ({ now, id, principal: p }) => {
      const draft = draftOf(db, p.workspace_id, row.draft_id);
      if (draft.revision !== input.expected_revision) throw new QoopiaError("STALE_REVISION", "Self-report requires the tested draft revision");
      db.query(`INSERT INTO authority_events(id,workspace_id,actor_id,origin_instance_id,created_at_ms,command_id,kind,subject_id,details_json)
        VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,'skill_test_self_reported',?,?)`).run(randomUUID(), p.workspace_id, p.id, now, id, row.skill_id,
        JSON.stringify({ revision_id: draft.head_revision_id, tested_at: input.tested_at, evidence_class: "self_reported", tester_agent: p.id }));
      return { data: { skill_id: row.skill_id }, revision: draft.revision };
    });
  return { id: row.skill_id, created: false, slug: row.slug, type: "skill", workspace_id: auth.workspace_id,
    updated_at: input.tested_at, revision: response.revision, draft_id: row.draft_id };
}

export function sunsetAllowed(input: { release_at_ms: number; now_ms: number; subsequent_minor_releases: number; consumers_migrated: boolean }): boolean {
  return input.now_ms >= input.release_at_ms + 90 * 86400_000 && input.subsequent_minor_releases >= 2 && input.consumers_migrated;
}
