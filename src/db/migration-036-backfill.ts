import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { contentSchema, COMPILER, contentDigest, missingRequirements } from "../skills/format.ts";
import { canonical, digest } from "../skills/commands.ts";

/** Existing generic skill rows gain an immutable original, never an inferred human author. Runs inside migration transaction. */
export function backfill036(database: Database) {
  // Every pre036 principal could use the old skill API subject to its live profile
  // and token scope. Do not infer human ownership or broader authority from type.
  const principals = database.query("SELECT id,workspace_id,type,active,tool_profile FROM agents ORDER BY workspace_id,id").all() as Array<{
    id: string; workspace_id: string; type: string; active: number; tool_profile: string;
  }>;
  database.run("UPDATE agents SET legacy_skill_access=1");
  const rows = database.query("SELECT * FROM entity_pages WHERE type='skill' AND id NOT IN (SELECT skill_id FROM skill_drafts)").all() as Array<{
    id: string; workspace_id: string; title: string; summary: string | null; metadata: string; created_at: string; updated_at: string;
  }>;
  const origin = (database.query("SELECT instance_id FROM authority_instance").get() as { instance_id: string }).instance_id;
  const actors = new Map<string, string>();
  for (const row of rows) {
    let actor = actors.get(row.workspace_id);
    if (!actor) {
      actor = randomUUID(); actors.set(row.workspace_id, actor);
      database.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,active,tool_profile) VALUES (?,?,'legacy-skill-provenance','standard',?,0,'read-only')")
        .run(actor, row.workspace_id, digest(randomUUID()));
    }
    const metadata = JSON.parse(row.metadata);
    const list = (value: unknown): string[] => Array.isArray(value) && value.every((v) => typeof v === "string") ? value.slice(0, 100) : [];
    const content = contentSchema.parse({ title: row.title, purpose: row.summary ?? "", trigger: list(metadata.trigger_conditions),
      procedure: list(metadata.exact_steps), verification: list(metadata.verification_gates), failure_modes: list(metadata.failure_modes),
      rollback: typeof metadata.rollback === "string" ? metadata.rollback : "", compatibility: list(metadata.prerequisites) });
    const now = Date.parse(row.updated_at);
    if (!Number.isSafeInteger(now)) throw new Error(`Migration036 requires an unambiguous updated_at for skill identity ${row.id}; restore pre-migrate backup`);
    const draft = randomUUID(), revision = randomUUID();
    database.query(`INSERT INTO skill_drafts(id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,revision,skill_id,head_revision_id) VALUES (?,?,?,?,?,?,1,?,?)`)
      .run(draft, row.workspace_id, actor, origin, now, now, row.id, revision);
    database.query(`INSERT INTO skill_draft_revisions(id,workspace_id,actor_id,origin_instance_id,created_at_ms,draft_id,revision_no,source_refs,content_json,content_digest,compiler_version,missing_requirements,legacy_runbook_json)
      VALUES (?,?,?,?,?,?,1,'[]',?,?,?,?,?)`).run(revision, row.workspace_id, actor, origin, now, draft, canonical(content), contentDigest(content), COMPILER,
      canonical(missingRequirements(content)), canonical({ ...row, metadata }));
  }
  return { principals: principals.map((p) => ({ ...p, legacy_skill_access: 1,
    authority_profile: "memory-worker", principal_kind: "agent",
    profile_allows_skill_write: p.active === 1 && ["full", "no-destructive"].includes(p.tool_profile),
    oauth_scope: "unchanged; intersect at each call", owner_mapping: "none" })), skills: rows.length };
}
