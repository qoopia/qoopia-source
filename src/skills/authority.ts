import { randomUUID } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { authorize, mayEdit, requireAgent, requireHumanOwner, type Principal } from "../auth/policy.ts";
import { QoopiaError } from "../utils/errors.ts";
import { command, canonical, digest } from "./commands.ts";
import { COMPILER, validatedContent, missingRequirements, contentDigest, compileContent,
  contentSchema, parsePackage, signaturePayload, type Descriptor } from "./format.ts";
import { verifyJws } from "./legacy/signing.ts";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const reviseSchema = z.object({
  draft_id: id.optional(), skill_id:id.optional(), slug: z.string().regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/).max(200),
  parent_skill_id: id.optional(), expected_revision: z.number().int().nonnegative(),
  content: contentSchema, source_refs: z.array(z.object({ kind: z.literal("note"), id, digest: hash }).strict()).max(100).default([]),
  idempotency_key: key,
}).strict();
export const compileSchema = z.object({
  draft_id: id, expected_revision: z.number().int().positive(), version_label: z.string().min(1).max(100),
  license: z.string().min(1).max(200), native_name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(), members: z.record(z.string().max(4 * 1024 * 1024)).default({}), idempotency_key: key,
}).strict();
export const reviewSchema = z.object({
  version_id: id, expected_digest: hash, expected_revision: z.number().int().nonnegative(),
  kind: z.enum(["content_review", "local_use", "high_risk_adoption", "publish_export"]),
  decision: z.enum(["approve", "reject"]), evidence_class: z.enum(["self_reported", "independently_verified", "human_accepted"]),
  package_digest: hash.optional(), target_agent_id: id.optional(), runtime_id: id.optional(), operation_id: id.optional(),
  target_scope: id, capabilities: z.array(id).max(100), expires_at_ms: z.number().int().positive(),
  policy_epoch: z.number().int().positive(), evidence_refs: z.array(id).max(100).default([]), idempotency_key: key,
}).strict();
export const sealSchema = z.object({
  version_id: id, expected_digest: hash, approval_ids: z.array(id).min(1).max(100),
  publisher_key_id: id, signature: z.string().min(1).max(4096), idempotency_key: key,
}).strict();
export const signingKeySchema = z.object({
  kid: id, public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expected_revision: z.literal(0), idempotency_key: key,
}).strict();

interface Draft { id: string; workspace_id: string; actor_id: string; skill_id: string; revision: number; head_revision_id: string; }
export interface Version {
  id: string; workspace_id: string; actor_id: string; skill_id: string; version_label: string;
  candidate_digest: string; content_digest: string; package_digest: string | null;
  descriptor_json: string; members_json: string; source_revision_id: string | null;
  package_bytes: Uint8Array | null; status: string; license: string;
}
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new QoopiaError("INVALID_INPUT", parsed.error.message);
  return parsed.data;
}
export function draftOf(database: Database, workspace: string, draftId: string): Draft {
  const d = database.query("SELECT * FROM skill_drafts WHERE workspace_id=? AND id=?")
    .get(workspace, draftId) as Draft | null;
  if (!d) throw new QoopiaError("NOT_FOUND", "Draft not found");
  return d;
}
export function versionOf(database: Database, workspace: string, versionId: string): Version {
  const v = database.query("SELECT * FROM skill_versions WHERE workspace_id=? AND id=?")
    .get(workspace, versionId) as Version | null;
  if (!v) throw new QoopiaError("NOT_FOUND", "Version not found");
  return v;
}
function checkSources(database: Database, p: Principal, refs: z.infer<typeof reviseSchema>["source_refs"]): void {
  for (const ref of refs) {
    const n = database.query(`SELECT text FROM notes WHERE workspace_id=? AND id=?
      AND (visibility='workspace' OR agent_id=?)`).get(p.workspace_id, ref.id, p.id) as { text: string } | null;
    if (!n) throw new QoopiaError("NOT_FOUND", "Source not found in authorized scope");
    if (digest(n.text) !== ref.digest) throw new QoopiaError("STALE_REVISION", "Source changed; reload the authorized source");
  }
}

export function reviseDraft(auth: AuthContext, input: unknown, database: Database = db, legacyRunbook?: Record<string, unknown>) {
  const a = parse(reviseSchema, input);
  const checkEdit = (p: Principal, d: Draft) => {
    requireSkillRead(database, p, d.skill_id);
    // Only identities born in the legacy API retain its workspace-wide editing.
    // Immutable revision 1 is provenance, not a caller-controlled grant on a new draft.
    if (legacyRunbook && p.legacy_skill_access === 1) {
      if (database.query(
        "SELECT 1 FROM skill_draft_revisions WHERE draft_id=? AND workspace_id=? AND revision_no=1 AND legacy_runbook_json IS NOT NULL",
      ).get(d.id, p.workspace_id)) return;
      // New canonical identities still require current canonical authority, even
      // if this caller authored one while it previously held a broader grant.
      authorize(database, auth, "draft");
    }
    mayEdit(p, d.actor_id);
  };
  return command(database, auth, legacyRunbook ? "legacy-skill" : "draft", "skill_draft_revise", a.idempotency_key,
    legacyRunbook ? { ...a, legacy_runbook: legacyRunbook } : a, a.draft_id ?? a.slug,
    (p) => {
      if(a.skill_id){requireHumanOwner(database,p);requireSkillRead(database,p,a.skill_id);if(a.draft_id)throw new QoopiaError('INVALID_INPUT','Choose draft_id or an undrafted skill_id');}
      if (a.draft_id) checkEdit(p, draftOf(database, p.workspace_id, a.draft_id));
      if (legacyRunbook) {
        const old = database.query("SELECT d.* FROM skill_drafts d JOIN entity_pages e ON e.id=d.skill_id WHERE e.workspace_id=? AND e.slug=?")
          .get(p.workspace_id, a.slug) as Draft | null;
        if (old) checkEdit(p, old);
      }
      if (a.parent_skill_id && !database.query("SELECT 1 FROM entity_pages WHERE workspace_id=? AND id=? AND type='skill'")
        .get(p.workspace_id, a.parent_skill_id)) throw new QoopiaError("NOT_FOUND", "Fork origin not found");
      if (a.parent_skill_id) requireSkillRead(database, p, a.parent_skill_id);
      checkSources(database, p, a.source_refs);
    }, ({ now, principal: p }) => {
      const content = validatedContent(a.content);
      let d: Draft;
      const legacyDraft = legacyRunbook ? database.query("SELECT d.id FROM skill_drafts d JOIN entity_pages e ON e.id=d.skill_id WHERE e.workspace_id=? AND e.slug=?")
        .get(p.workspace_id, a.slug) as { id: string } | null : null;
      if (a.draft_id || legacyDraft) {
        d = draftOf(database, p.workspace_id, a.draft_id ?? legacyDraft!.id);
      } else {
        if (a.expected_revision !== 0) throw new QoopiaError("STALE_REVISION", "A new draft requires revision 0");
        if (database.query("SELECT 1 FROM entity_pages WHERE workspace_id=? AND slug=? AND id!=?").get(p.workspace_id, a.slug,a.skill_id??'')) {
          throw new QoopiaError("CONFLICT", "Slug exists; explicitly revise its draft or choose a fork slug");
        }
        const skillId = a.skill_id??ulid(), draftId = randomUUID();
        if(a.skill_id&&database.query('SELECT 1 FROM skill_drafts WHERE skill_id=?').get(a.skill_id))throw new QoopiaError('CONFLICT','Skill already has a draft; revise its current head');
        if(!a.skill_id)database.query(`INSERT INTO entity_pages (id,workspace_id,type,slug,title,summary,metadata)
          VALUES (?,?,'skill',?,?,?,'{}')`).run(skillId, p.workspace_id, a.slug, content.title, content.purpose);
        database.query(`INSERT INTO skill_drafts (id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,skill_id,parent_skill_id)
          VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?)`).run(draftId, p.workspace_id, p.id, now, now, skillId, a.parent_skill_id ?? null);
        d = draftOf(database, p.workspace_id, draftId);
      }
      if (d.revision !== a.expected_revision) {
        // The caller retains the submitted content; no losing edit is discarded or replaced by a cached winner.
        throw new QoopiaError("STALE_REVISION", `Current revision is ${d.revision}; preserve submitted content and rebase against draft ${d.id}`,
          { current_revision: d.revision, submitted_content: content, base_revision: a.expected_revision, draft_id: d.id });
      }
      const clash = database.query("SELECT id FROM entity_pages WHERE workspace_id=? AND slug=? AND id!=?").get(p.workspace_id, a.slug, d.skill_id);
      if (clash) throw new QoopiaError("CONFLICT", "Slug belongs to another identity");
      const revisionId = randomUUID(), revision = d.revision + 1;
      const missing = missingRequirements(content), contentHash = contentDigest(content);
      database.query(`INSERT INTO skill_draft_revisions
        (id,workspace_id,actor_id,origin_instance_id,created_at_ms,draft_id,revision_no,parent_revision_id,
         source_refs,source_digest,content_json,content_digest,compiler_version,missing_requirements,legacy_runbook_json)
        VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?,?,?,?,?,?,?,?)`).run(revisionId, p.workspace_id, p.id, now, d.id, revision,
        d.head_revision_id ?? null, canonical(a.source_refs), digest(canonical(a.source_refs)), canonical(content), contentHash, COMPILER, canonical(missing),
        legacyRunbook ? canonical(legacyRunbook) : null);
      const changed = database.query(`UPDATE skill_drafts SET revision=?,head_revision_id=?,updated_at_ms=? WHERE id=? AND revision=? RETURNING id`)
        .get(revision, revisionId, now, d.id, a.expected_revision);
      if (!changed) throw new QoopiaError("STALE_REVISION", "Concurrent draft change; submitted content remains recoverable in request");
      database.query("UPDATE entity_pages SET slug=?,title=?,summary=?,status=COALESCE(?,status),updated_at=? WHERE id=? AND workspace_id=?")
        .run(a.slug, content.title, content.purpose, legacyRunbook?.status == null ? null : String(legacyRunbook.status), new Date(now).toISOString(), d.skill_id, p.workspace_id);
      return { data: { skill_id: d.skill_id, draft_id: d.id, revision_id: revisionId, content_digest: contentHash, missing_requirements: missing }, revision };
    });
}

export function compileDraft(auth: AuthContext, input: unknown, database: Database = db) {
  const a = parse(compileSchema, input);
  return command(database, auth, "draft", "skill_compile", a.idempotency_key, a, a.draft_id,
    (p) => mayEdit(p, draftOf(database, p.workspace_id, a.draft_id).actor_id), ({ now, principal: p }) => {
      const d = draftOf(database, p.workspace_id, a.draft_id);
      if (d.revision !== a.expected_revision) throw new QoopiaError("STALE_REVISION", "Compile requires the current exact draft revision");
      const r = database.query("SELECT content_json FROM skill_draft_revisions WHERE id=? AND workspace_id=?")
        .get(d.head_revision_id, p.workspace_id) as { content_json: string };
      const compiled = compileContent(validatedContent(JSON.parse(r.content_json)), a.version_label, a.license, a.members, a.native_name);
      const prior = database.query("SELECT id,candidate_digest FROM skill_versions WHERE skill_id=? AND version_label=?")
        .get(d.skill_id, a.version_label) as { id: string; candidate_digest: string } | null;
      if (prior) {
        if (prior.candidate_digest !== compiled.candidate_digest) throw new QoopiaError("CONFLICT", "Version label already names different frozen bytes");
        return { data: { version_id: prior.id, candidate_digest: compiled.candidate_digest, content_digest: compiled.content_digest }, revision: d.revision };
      }
      const versionId = randomUUID();
      database.query(`INSERT INTO skill_versions
        (id,workspace_id,actor_id,origin_instance_id,created_at_ms,skill_id,version_label,candidate_digest,content_digest,
         original_format,manifest_schema,source_revision_id,lineage_refs,license,descriptor_json,members_json,status)
        VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?,?,'qoopia-skill-package/1','qoopia-skill-candidate/1',?,'[]',?,?,?,'candidate')`)
        .run(versionId, p.workspace_id, p.id, now, d.skill_id, a.version_label, compiled.candidate_digest, compiled.content_digest,
          d.head_revision_id, a.license, canonical(compiled.descriptor), canonical(compiled.members));
      return { data: { version_id: versionId, candidate_digest: compiled.candidate_digest, content_digest: compiled.content_digest }, revision: d.revision };
    });
}

export function reviewSkill(auth: AuthContext, input: unknown, database: Database = db) {
  const a = parse(reviewSchema, input), human = a.kind !== "content_review";
  return command(database, auth, human ? "owner" : "review", "skill_review", a.idempotency_key, a, a.version_id,
    (p) => {
      requireSkillRead(database, p, versionOf(database, p.workspace_id, a.version_id).skill_id);
      if (a.target_agent_id) requireAgent(database, p.workspace_id, a.target_agent_id);
    }, ({ now, principal: p }) => {
      const v = versionOf(database, p.workspace_id, a.version_id);
      if (v.candidate_digest !== a.expected_digest) throw new QoopiaError("STALE_REVISION", "Candidate digest mismatch");
      const prior = database.query("SELECT count(*) AS n FROM skill_approvals WHERE version_id=? AND actor_id=? AND kind=?")
        .get(v.id, p.id, a.kind) as { n: number };
      if (prior.n !== a.expected_revision) throw new QoopiaError("STALE_REVISION", "Review was concurrently decided; reload the review history");
      if (a.policy_epoch !== p.policy_epoch || a.expires_at_ms <= now || a.expires_at_ms > now + 30 * 86400_000) {
        throw new QoopiaError("EXPIRED", "Consent requires the current epoch and an expiry within 30 days");
      }
      const sourceAuthor = v.source_revision_id ? database.query("SELECT actor_id FROM skill_draft_revisions WHERE id=?").get(v.source_revision_id) as { actor_id: string } | null : null;
      if (a.evidence_class === "independently_verified" && (v.actor_id === p.id || sourceAuthor?.actor_id === p.id || !a.evidence_refs.length)) {
        throw new QoopiaError("FORBIDDEN", "Independent verification requires a distinct reviewer and evidence");
      }
      if (a.evidence_class === "human_accepted") requireHumanOwner(database, p);
      const descriptor = JSON.parse(v.descriptor_json) as Descriptor;
      if (canonical([...a.capabilities].sort()) !== canonical([...descriptor.requested_capabilities].sort())) {
        throw new QoopiaError("APPROVAL_REQUIRED", "Consent capability scope must match the exact descriptor");
      }
      if (a.kind === "high_risk_adoption") {
        if (v.status !== "sealed" || a.package_digest !== v.package_digest || !a.target_agent_id || !a.runtime_id || !a.operation_id) {
          throw new QoopiaError("APPROVAL_REQUIRED", "High-risk consent requires an exact sealed digest, target, runtime and operation");
        }
        if (!database.query("SELECT 1 FROM runtime_registrations WHERE workspace_id=? AND target_agent_id=? AND id=?")
          .get(p.workspace_id, a.target_agent_id, a.runtime_id)) throw new QoopiaError("NOT_FOUND", "Runtime target not registered");
      }
      const approvalId = randomUUID();
      database.query(`INSERT INTO skill_approvals
        (id,workspace_id,actor_id,origin_instance_id,created_at_ms,version_id,kind,candidate_digest,package_digest,actor_role,
         decision,evidence_class,capability_scope,target_scope,target_agent_id,runtime_id,operation_id,expires_at_ms,policy_version,evidence_refs,decision_revision)
        VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(approvalId, p.workspace_id, p.id, now, v.id, a.kind,
        v.candidate_digest, a.package_digest ?? null, p.principal_kind, a.decision, a.evidence_class, canonical([...a.capabilities].sort()),
        a.target_scope, a.target_agent_id ?? null, a.runtime_id ?? null, a.operation_id ?? null, a.expires_at_ms, p.policy_epoch, canonical(a.evidence_refs), prior.n + 1);
      return { data: { approval_id: approvalId, evidence_class: a.evidence_class, decision: a.decision }, revision: prior.n + 1 };
    });
}

/** Exact human consent is checked at use time; historical approvals are never authority by themselves. */
export function requireExactConsent(database: Database, auth: AuthContext, input: {
  approval_id: string; version_id: string; package_digest: string; target_agent_id: string;
  runtime_id: string; target_scope: string; operation_id: string; capabilities: string[]; policy_epoch: number;
}): void {
  const p = authorize(database, auth, "read");
  const v = versionOf(database, p.workspace_id, input.version_id);
  requireSkillRead(database, p, v.skill_id);
  requireAgent(database, p.workspace_id, input.target_agent_id);
  if (!database.query("SELECT 1 FROM runtime_registrations WHERE workspace_id=? AND target_agent_id=? AND id=?")
    .get(p.workspace_id, input.target_agent_id, input.runtime_id)) throw new QoopiaError("APPROVAL_REQUIRED", "The exact runtime registration is no longer current");
  const row = database.query(`SELECT a.* FROM skill_approvals a JOIN agents p ON p.id=a.actor_id AND p.workspace_id=a.workspace_id
    JOIN workspace_owners o ON o.actor_id=p.id AND o.workspace_id=p.workspace_id
    WHERE a.id=? AND a.workspace_id=? AND p.active=1 AND p.principal_kind='human' AND a.policy_version=p.policy_epoch
    AND NOT EXISTS(SELECT 1 FROM skill_approvals newer WHERE newer.version_id=a.version_id AND newer.actor_id=a.actor_id AND newer.kind=a.kind AND newer.decision_revision>a.decision_revision)`)
    .get(input.approval_id, p.workspace_id) as Record<string, unknown> | null;
  if (!row || row.kind !== "high_risk_adoption" || row.decision !== "approve" || Number(row.expires_at_ms) <= Date.now() ||
      row.version_id !== v.id || v.status !== "sealed" || v.package_digest !== input.package_digest ||
      row.package_digest !== input.package_digest || row.target_agent_id !== input.target_agent_id ||
      row.runtime_id !== input.runtime_id || row.target_scope !== input.target_scope || row.operation_id !== input.operation_id ||
      row.policy_version !== input.policy_epoch || row.capability_scope !== canonical([...input.capabilities].sort())) {
    throw new QoopiaError("APPROVAL_REQUIRED", "A current exact human adoption consent is required");
  }
}

export function registerPublisherKey(auth: AuthContext, input: unknown, database: Database = db) {
  const a = parse(signingKeySchema, input);
  return command(database, auth, "owner", "publisher_key_register", a.idempotency_key, a, a.kid, () => {}, ({ now, principal: p }) => {
    if (database.query("SELECT 1 FROM publisher_keys WHERE workspace_id=? AND kid=?").get(p.workspace_id, a.kid)) {
      throw new QoopiaError("CONFLICT", "Publisher key identifier already exists");
    }
    database.query("INSERT INTO publisher_keys(id,workspace_id,actor_id,origin_instance_id,created_at_ms,kid,public_key) VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?)")
      .run(randomUUID(), p.workspace_id, p.id, now, a.kid, a.public_key);
    return { data: { kid: a.kid }, revision: 1 };
  });
}

export function sealSkill(auth: AuthContext, input: unknown, database: Database = db) {
  const a = parse(sealSchema, input);
  return command(database, auth, "seal", "skill_seal", a.idempotency_key, a, a.version_id,
    (p) => { requireSkillRead(database, p, versionOf(database, p.workspace_id, a.version_id).skill_id); }, ({ now, principal: p }) => {
      const v = versionOf(database, p.workspace_id, a.version_id);
      if (v.candidate_digest !== a.expected_digest) throw new QoopiaError("STALE_REVISION", "Candidate digest mismatch");
      if (v.status !== "candidate") throw new QoopiaError("CONFLICT", "Version already sealed; read the original operation");
      const signingKey = database.query("SELECT public_key FROM publisher_keys WHERE workspace_id=? AND kid=? AND revoked_at_ms IS NULL")
        .get(p.workspace_id, a.publisher_key_id) as { public_key: string } | null;
      if (!signingKey) throw new QoopiaError("UNTRUSTED_SIGNING_KEY", "Current publisher key not registered");
      const descriptor = JSON.parse(v.descriptor_json) as Descriptor;
      let contentApproved = false;
      for (const approvalId of a.approval_ids) {
        const approved = database.query(`SELECT a.* FROM skill_approvals a JOIN agents p ON p.id=a.actor_id
          WHERE a.id=? AND a.workspace_id=? AND a.version_id=? AND p.active=1 AND p.policy_epoch=a.policy_version
          AND NOT EXISTS(SELECT 1 FROM skill_approvals newer WHERE newer.version_id=a.version_id AND newer.actor_id=a.actor_id AND newer.kind=a.kind AND newer.decision_revision>a.decision_revision)`)
          .get(approvalId, p.workspace_id, v.id) as Record<string, unknown> | null;
        if (!approved || approved.decision !== "approve" || approved.candidate_digest !== v.candidate_digest ||
            Number(approved.expires_at_ms) <= now) throw new QoopiaError("APPROVAL_REQUIRED", "Approval is absent, rejected, expired or revoked");
        if (approved.kind === "content_review") contentApproved = true;
      }
      if (!contentApproved) throw new QoopiaError("APPROVAL_REQUIRED", "Exact content review is required for sealing");
      const check = verifyJws(signaturePayload(descriptor), a.signature, signingKey.public_key);
      if (!check.ok || check.kid !== a.publisher_key_id) throw new QoopiaError("UNTRUSTED_SIGNING_KEY", "Detached signature does not cover this candidate");
      const bytes = Buffer.from(canonical({ format: "qoopia-skill-package/1", signature_profile: "qoopia-skill-signature/1",
        descriptor, members: JSON.parse(v.members_json), signature: a.signature }));
      const packageDigest = digest(bytes);
      parsePackage(bytes, packageDigest, signingKey.public_key, a.publisher_key_id);
      database.query(`UPDATE skill_versions SET status='sealed',package_digest=?,package_bytes=?,publisher_key_id=?,signature_ref=?,sealed_at_ms=? WHERE id=?`)
        .run(packageDigest, bytes, a.publisher_key_id, a.signature, now, v.id);
      return { data: { version_id: v.id, candidate_digest: v.candidate_digest, package_digest: packageDigest, status: "sealed" }, revision: 1 };
    });
}

export function getSkillVersion(auth: AuthContext, versionId: string, database: Database = db) {
  const p = authorize(database, auth, "read"), v = versionOf(database, p.workspace_id, versionId);
  requireSkillRead(database, p, v.skill_id);
  const { package_bytes: bytes, ...metadata } = v;
  return { ...metadata, package_available: bytes !== null };
}

export function requireSkillRead(database: Database, p: Principal, skillId: string): void {
  const row = database.query(`SELECT 1 FROM entity_pages WHERE id=? AND workspace_id=? AND
    (authority_private=0 OR authority_owner_id=? OR EXISTS(SELECT 1 FROM workspace_owners WHERE workspace_id=? AND actor_id=?))`)
    .get(skillId, p.workspace_id, p.id, p.workspace_id, p.id);
  if (!row) throw new QoopiaError("NOT_FOUND", "Skill not found in authorized scope");
}
