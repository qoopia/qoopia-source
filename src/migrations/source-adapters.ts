import { assetPath } from "../utils/assets.ts";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runPhaseA, buildStagingPlan } from "../db/migration-033-plan.ts";
import { supersedeGraphDigest, assertMigration033Gate } from "../db/migration-033-gate.ts";
import { applyMigration033Sql } from "../db/migration-033-exec.ts";
import { runPhaseB } from "../../scripts/migrate-033-preflight.ts";
import qoopia32 from "./qoopia-32-manifest.json";
import qoopia35 from "./qoopia-35-manifest.json";
import skillonomia19 from "./skillonomia-19-manifest.json";
import { canonical, digest } from "../skills/commands.ts";
import { contentSchema, contentDigest, COMPILER, missingRequirements } from "../skills/format.ts";
import { manifestHash, verifyJws } from "../skills/legacy/signing.ts";
import { jcsBytes, parseJsonStrict, utf8Decode, type JcsValue } from "../skills/legacy/jcs.ts";
import { readPackage, computeIntegrity } from "../skills/legacy/archive.ts";
import { QoopiaError } from "../utils/errors.ts";

type Row = Record<string, SQLQueryBindings>;
type Manifest = Record<string, string[]>;
export interface SourceSnapshot { kind: "qoopia" | "skillonomia"; origin: string; bytes: Uint8Array; blobs?: ReadonlyMap<string, Buffer>; }
interface Original { table: string; id: string; row: Row; bytes: Buffer; hash: string; }
export interface SourcePlan { source_digest: string; source_schema: number; source_kind: string; origin: string;
  canonical_rows: number; counts: Record<string, number>; immutable_packages: number; tlog_rows: number; }
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
function encodedRow(row: Row): Buffer {
  return Buffer.from(canonical(Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
    ArrayBuffer.isView(v) ? { sqlite_blob_base64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") } : v]))));
}
function openSnapshot(source: SourceSnapshot): Database {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(source.origin)) throw new QoopiaError("INVALID_INPUT", "Stable origin instance identifier required");
  if (source.bytes.byteLength > 256 * 1024 * 1024) throw new QoopiaError("SIZE_LIMIT", "P1 adapter accepts snapshots up to 256 MiB per source");
  const bytes = Buffer.from(source.bytes);
  if (bytes.subarray(0, 16).toString() !== "SQLite format 3\0" || bytes[18] !== 1 || bytes[19] !== 1) {
    throw new QoopiaError("UNSUPPORTED", "A closed, verified SQLite backup snapshot in rollback-journal format is required; raw WAL database files are not snapshots");
  }
  return Database.deserialize(bytes, true);
}
function inspect(source: SourceSnapshot, database: Database) {
  const version = source.kind === "qoopia"
    ? (database.query("SELECT max(version) AS n FROM schema_versions").get() as { n: number }).n
    : (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (source.kind === "skillonomia" && version === 10) throw new QoopiaError("UNSUPPORTED_SCHEMA", "Skillonomia schema10 is ambiguous: restore the pre-upgrade snapshot; never guess whether replay keys were already hashed");
  const manifest: Manifest | undefined = source.kind === "qoopia" ? version === 32 ? qoopia32 : version === 35 ? qoopia35 : undefined : version === 19 ? skillonomia19 : undefined;
  if (!manifest) throw new QoopiaError("UNSUPPORTED_SCHEMA", `Unsupported ${source.kind} schema ${version}`);
  const integrity = database.query("PRAGMA integrity_check").all();
  if (canonical(integrity) !== canonical([{ integrity_check: "ok" }]) || database.query("PRAGMA foreign_key_check").all().length) {
    throw new QoopiaError("QUARANTINED", "Source integrity or foreign-key check failed");
  }
  const tables = database.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  if (canonical(tables.map((t) => t.name).sort()) !== canonical(Object.keys(manifest).sort())) {
    throw new QoopiaError("UNSUPPORTED_SCHEMA", "Unknown or missing source table; explicit versioned adapter required");
  }
  const virtual = tables.filter((t) => /CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
  const originals: Original[] = [], counts: Record<string, number> = {};
  for (const t of tables) {
    const columns = database.query(`PRAGMA table_info(${quoted(t.name)})`).all() as { name: string; pk: number }[];
    if (canonical(columns.map((c) => c.name)) !== canonical(manifest[t.name])) throw new QoopiaError("UNSUPPORTED_SCHEMA", "Unknown source columns; refusing lossy projection");
    if (t.name === "schema_versions" || virtual.some((v) => t.name === v || t.name.startsWith(`${v}_`))) continue;
    const pks = columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const rows = database.query(`SELECT ${pks.length ? "" : "rowid AS __source_rowid__,"}* FROM ${quoted(t.name)}`).all() as Row[];
    if (rows.length > 100_000) throw new QoopiaError("SIZE_LIMIT", "P1 adapter accepts at most 100,000 rows per canonical table");
    counts[t.name] = rows.length;
    for (const row of rows) {
      const identity = row.id !== undefined ? String(row.id) : canonical(pks.length ? pks.map((k) => row[k]) : [row.__source_rowid__]);
      const bytes = encodedRow(row);
      originals.push({ table: t.name, id: identity, row, bytes, hash: digest(bytes) });
    }
  }
  let tlogRows = 0, immutablePackages = 0;
  if (source.kind === "skillonomia") {
    let prev = "0".repeat(64);
    for (const row of database.query("SELECT * FROM transparency_log ORDER BY seq").all() as Array<Record<string, unknown>>) {
      tlogRows++;
      const covered = { seq: row.seq, event_kind: row.event_kind, subject_id: row.subject_id, payload_hash: row.payload_hash, server_at_ms: row.server_at_ms };
      const expected = digest(Buffer.concat([Buffer.from(prev, "hex"), Buffer.from(digest(jcsBytes(covered as JcsValue)), "hex")]));
      if (row.seq !== tlogRows || row.prev_hash !== prev || row.this_hash !== expected) throw new QoopiaError("CHECKSUM_MISMATCH", "Original transparency chain failed verification");
      prev = expected;
    }
    for (const original of originals.filter((r) => r.table === "skill_versions")) {
      const r = original.row, blob = source.blobs?.get(String(r.package_blob_ref));
      if (!blob) throw new QoopiaError("QUARANTINED", "A referenced original package blob is missing");
      const manifestValue = parseJsonStrict(String(r.manifest_json));
      if (manifestHash(manifestValue) !== r.manifest_hash) throw new QoopiaError("CHECKSUM_MISMATCH", "Legacy manifest digest changed");
      const signature = verifyJws(manifestValue, String(r.signature_jws));
      const key = database.query("SELECT public_key_ed25519 FROM signing_keys WHERE kid=? AND agent_id=?")
        .get(signature.kid ?? "", r.author_agent_id!) as { public_key_ed25519: string } | null;
      if (!key || !verifyJws(manifestValue, String(r.signature_jws), key.public_key_ed25519).ok) throw new QoopiaError("UNTRUSTED_SIGNING_KEY", "Original author signature cannot be verified");
      const files = readPackage(blob, blob[0] === 0x1f && blob[1] === 0x8b ? "tar.gz" : "tar");
      if (!files.get("skill.json") || manifestHash(parseJsonStrict(utf8Decode(files.get("skill.json")!))) !== r.manifest_hash ||
          files.get("SIGNATURE.jws")?.toString() !== r.signature_jws || digest(canonical(computeIntegrity(files))) !== r.content_hash) {
        throw new QoopiaError("CHECKSUM_MISMATCH", "Original package members, signature or integrity bytes disagree with the registry");
      }
      immutablePackages++;
    }
  }
  const blobManifest = [...(source.blobs ?? [])].map(([ref, bytes]) => ({ ref, size: bytes.length, digest: digest(bytes) })).sort((a, b) => a.ref.localeCompare(b.ref));
  const plan: SourcePlan = { source_digest: digest(canonical({ database: digest(source.bytes), blobs: blobManifest })), source_schema: version,
    source_kind: source.kind, origin: source.origin, canonical_rows: originals.length, counts, immutable_packages: immutablePackages, tlog_rows: tlogRows };
  return { plan, originals };
}

export function preflightSource(source: SourceSnapshot): SourcePlan {
  const d = openSnapshot(source);
  try { return inspect(source, d).plan; } finally { d.close(); }
}

/** P1 fixture import is one rollback-safe transaction. Production writer barriers/cutover belong to P3. */
export function importSource(target: Database, source: SourceSnapshot, input: { build_sha: string; workspace_map: Record<string, string>; archive_workspace?: string }) {
  const original = openSnapshot(source);
  let normalized32: Database | undefined;
  try {
    const { plan, originals } = inspect(source, original);
    if (source.kind === "qoopia" && plan.source_schema === 32) {
      normalized32 = Database.deserialize(source.bytes);
      const work = normalized32;
      work.transaction(() => {
        const report = runPhaseA(work), staging = buildStagingPlan(work, report);
        runPhaseB(work, staging, supersedeGraphDigest(work));
        assertMigration033Gate(work);
        applyMigration033Sql(work, readFileSync(assetPath("migrations/033-notes-bitemporal.sql"), "utf8"));
      })();
    }
    return target.transaction(() => {
      if (!/^[a-f0-9]{40}$/.test(input.build_sha)) throw new QoopiaError("INVALID_INPUT", "Exact migrator build SHA required");
      if (input.archive_workspace && !Object.values(input.workspace_map).includes(input.archive_workspace)) {
        throw new QoopiaError("INVALID_INPUT", "Archive workspace must be an explicitly mapped target workspace");
      }
      const mappingDigest = digest(canonical(input.archive_workspace ? [input.workspace_map, input.archive_workspace] : input.workspace_map));
      const prior = target.query("SELECT source_digest,mapping_digest,build_sha,report_json FROM migration_runs WHERE origin_instance_id=?")
        .get(source.origin) as { source_digest: string; mapping_digest: string; build_sha: string; report_json: string } | null;
      if (prior) {
        if (prior.source_digest !== plan.source_digest) throw new QoopiaError("CONFLICT", "Source snapshot changed; resume is invalidated");
        if (prior.mapping_digest !== mappingDigest || prior.build_sha !== input.build_sha) {
          throw new QoopiaError("CONFLICT", "Workspace mapping or migrator build changed; resume is invalidated");
        }
        return JSON.parse(prior.report_json);
      }
      for (const workspace of originals.filter((r) => r.table === "workspaces")) {
        const targetWs = input.workspace_map[workspace.id];
        if (!targetWs || !target.query("SELECT 1 FROM workspaces WHERE id=?").get(targetWs)) throw new QoopiaError("INVALID_INPUT", "Every source workspace requires an explicit existing target workspace mapping");
      }
      target.query(`INSERT INTO migration_runs(id,origin_instance_id,source_kind,source_digest,source_schema,mapping_version,build_sha,mapping_digest,stage,created_at_ms,report_json)
        VALUES (?,?,?,?,?,1,?,?,'applying',?,'{}')`).run(randomUUID(), source.origin, source.kind, plan.source_digest, plan.source_schema, input.build_sha, mappingDigest, Date.now());
      const map = new Map<string, string>(), localTypes = new Map<string, string>(), collisions: { table: string; reason: string }[] = [];
      const key = (table: string, identity: string) => `${table}\0${identity}`;
      const mapped = (table: string, value: SQLQueryBindings | undefined) => value == null ? null : map.get(key(table, String(value))) ?? String(value);
      const localTable = (table: string) => source.kind === "qoopia" ? table : ({ skills: "entity_pages", draft_revisions: "skill_draft_revisions", skill_versions: "skill_versions" } as Record<string, string>)[table] ?? (["agents", "workspaces"].includes(table) ? table : "migration_origins");
      const integerOffsets = new Map<string, number>();
      for (const table of new Set(originals.map(o => localTable(o.table)))) {
        const columns = target.query(`PRAGMA table_info(${quoted(table)})`).all() as { name: string; type: string; pk: number }[];
        if (columns.some(c => c.name === "id" && c.pk === 1 && c.type === "INTEGER")) {
          const { n } = target.query(`SELECT coalesce(max(id),0) AS n FROM ${quoted(table)}`).get() as { n: number };
          integerOffsets.set(table, n);
        }
      }
      for (const o of originals) {
        const table = localTable(o.table); localTypes.set(key(o.table, o.id), table);
        let localId = o.id;
        if (o.table === "workspaces") localId = input.workspace_map[o.id]!;
        else if (integerOffsets.has(table)) {
          const shifted = Number(o.id) + integerOffsets.get(table)!;
          if (!Number.isSafeInteger(shifted) || Number(o.id) < 1) throw new QoopiaError("QUARANTINED", "Source integer identity cannot be remapped safely");
          localId = String(shifted);
        }
        else if (table !== "migration_origins" && target.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
          (target.query(`PRAGMA table_info(${quoted(table)})`).all() as { name: string }[]).some((c) => c.name === "id") &&
          target.query(`SELECT 1 FROM ${quoted(table)} WHERE id=?`).get(localId)) {
          localId = randomUUID(); collisions.push({ table: o.table, reason: "ID collision preserved as a separate local identity" });
        }
        map.set(key(o.table, o.id), localId);
      }
      // Deferred foreign keys preserve cycles while every original is mapped before any canonical insert.
      target.run("PRAGMA defer_foreign_keys=ON");
      const migrationActors = new Map<string, string>();
      const actorFor = (workspace: string): string => {
        if (migrationActors.has(workspace)) return migrationActors.get(workspace)!;
        const actor = randomUUID();
        target.query(`INSERT INTO agents(id,workspace_id,name,type,api_key_hash,active,tool_profile) VALUES (?,?,?,'standard',?,0,'read-only')`)
          .run(actor, workspace, `migration:${source.origin}`, digest(randomUUID()));
        migrationActors.set(workspace, actor); return actor;
      };
      const originalById = new Map(originals.map(o => [key(o.table,o.id),o]));
      const sourceTables = new Set(originals.map(o => o.table));
      const sourceWorkspace = (o: Original): string => {
        if (o.table === "workspaces") return String(o.row.id);
        if (o.row.workspace_id) return String(o.row.workspace_id);
        if (source.kind === "qoopia" && o.table === "entity_links") {
          const left=originalById.get(key("entity_pages",String(o.row.source_entity_id))),right=originalById.get(key("entity_pages",String(o.row.target_entity_id)));
          if (!left || !right || left.row.workspace_id!==right.row.workspace_id) throw new QoopiaError("QUARANTINED","Entity link has missing or cross-workspace endpoints");
          return String(left.row.workspace_id);
        }
        for (const [field, table] of [["skill_id", "skills"], ["skill_version_id", "skill_versions"], ["agent_id", "agents"], ["actor_agent_id", "agents"], ["author_agent_id", "agents"], ["draft_revision_id", "draft_revisions"], ["assignment_id", "skill_assignments"]]) {
          if (o.row[field!] != null) {
            const ref = originalById.get(key(table!,String(o.row[field!])));
            if (ref) return sourceWorkspace(ref);
          }
        }
        const workspaces = Object.keys(input.workspace_map);
        if (workspaces.length === 1) return workspaces[0]!;
        // Global historical tlog/key metadata cannot be assigned to a guessed tenant.
        throw new QoopiaError("QUARANTINED", `No unambiguous workspace provenance for ${o.table}; provide a per-workspace source archive`);
      };
      const archive = (o: Original, disposition: string) => {
        const workspace = disposition === "global_protocol_archive" ? input.archive_workspace! : input.workspace_map[sourceWorkspace(o)]!;
        target.query(`INSERT INTO migration_origins(origin_instance_id,source_type,source_id,workspace_id,local_type,local_id,original_row,row_digest,disposition)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(source.origin, o.table, o.id, workspace, localTypes.get(key(o.table, o.id))!, map.get(key(o.table, o.id))!, o.bytes, o.hash, disposition);
      };
      const dependencyOrder: string[] = [], visited = new Set<string>();
      const visit = (table: string) => {
        if (visited.has(table)) return;
        visited.add(table);
        if (table === "entity_links" && source.kind === "qoopia") visit("entity_pages");
        for (const fk of original.query(`PRAGMA foreign_key_list(${quoted(table)})`).all() as { table: string }[]) {
          if (fk.table !== table && sourceTables.has(fk.table)) visit(fk.table);
        }
        dependencyOrder.push(table);
      };
      for (const table of sourceTables) visit(table);
      const ordered = [...originals].sort((a, b) => {
        if (source.kind === "qoopia") return dependencyOrder.indexOf(a.table) - dependencyOrder.indexOf(b.table);
        const priority = (table: string) => table === "workspaces" ? 0 : table === "agents" ? 1 : table === "skills" || table === "entity_pages" ? 2 : table === "draft_revisions" ? 3 : 4;
        return priority(a.table) - priority(b.table) || Number(a.row.revision ?? 0) - Number(b.row.revision ?? 0);
      });
      for (const o of ordered) {
        if (source.kind === "qoopia" && ["sync_applied_hashes","wake_slo_probes"].includes(o.table)) {
          if (!input.archive_workspace && Object.keys(input.workspace_map).length !== 1) throw new QoopiaError("INVALID_INPUT", "Global protocol history requires an explicit archive workspace");
          localTypes.set(key(o.table,o.id),"migration_origins");
          archive(o,input.archive_workspace?"global_protocol_archive":"paused_legacy_protocol");
          continue;
        }
        const workspace = input.workspace_map[sourceWorkspace(o)]!, localId = map.get(key(o.table, o.id))!;
        if (o.table === "workspaces") { archive(o, "explicit_workspace_mapping"); continue; }
        if (source.kind === "skillonomia") {
          if (o.table === "agents") {
            target.query(`INSERT INTO agents(id,workspace_id,name,type,api_key_hash,active,tool_profile,principal_kind)
              VALUES (?,?,?,'standard',?,0,'read-only',?)`).run(localId, workspace, String(o.row.name), digest(randomUUID()), o.row.type === "human" ? "human" : "agent");
          } else if (o.table === "skills") {
            let slug = String(o.row.slug);
            if (target.query("SELECT 1 FROM entity_pages WHERE workspace_id=? AND slug=?").get(workspace, slug)) {
              slug += `-import-${digest(source.origin + o.id).slice(0, 12)}`; collisions.push({ table: "skills", reason: "Slug collision preserved with an import suffix" });
            }
            target.query(`INSERT INTO entity_pages(id,workspace_id,type,slug,title,summary,metadata,authority_private,authority_owner_id)
              VALUES (?,?,'skill',?,?,NULL,'{}',?,?)`).run(localId, workspace, slug, String(o.row.slug), o.row.access_policy === "private" || o.row.access_policy === "invite" ? 1 : 0, mapped("agents", o.row.owner_agent_id));
          } else if (o.table === "skill_versions") {
            const blob = source.blobs!.get(String(o.row.package_blob_ref))!;
            target.query(`INSERT INTO skill_versions
              (id,workspace_id,actor_id,origin_instance_id,created_at_ms,skill_id,version_label,candidate_digest,content_digest,package_digest,
               original_format,manifest_schema,lineage_refs,license,descriptor_json,members_json,package_bytes,status,signature_ref)
              VALUES (?,?,?,?,?,?,?,?,?,?,'skillonomia-legacy','skillonomia-legacy','[]',?,?,'{}',?,'legacy_immutable',?)`)
              .run(localId, workspace, mapped("agents", o.row.author_agent_id), source.origin, Number(o.row.created_at_ms), mapped("skills", o.row.skill_id),
                String(o.row.semantic_version), String(o.row.manifest_hash), String(o.row.content_hash), digest(blob),
                String((JSON.parse(String(o.row.manifest_json)) as Record<string, unknown>).license ?? "unknown"), String(o.row.manifest_json), blob, String(o.row.signature_jws));
          } else if (o.table === "draft_revisions") {
            const old = JSON.parse(String(o.row.content_json));
            const skillId = `native-${source.origin}-${String(o.row.draft_id)}`, draftId = `draft-${source.origin}-${String(o.row.draft_id)}`;
            if (!target.query("SELECT 1 FROM skill_drafts WHERE id=?").get(draftId)) {
              target.query(`INSERT INTO entity_pages(id,workspace_id,type,slug,title,metadata,authority_private,authority_owner_id) VALUES (?,?,'skill',?,?,'{}',1,?)`)
                .run(skillId, workspace, `native-${digest(skillId).slice(0, 24)}`, String(old.title || "Imported native revision"), mapped("agents", o.row.author_agent_id));
              target.query(`INSERT INTO skill_drafts(id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,skill_id) VALUES (?,?,?,?,?,?,?)`)
                .run(draftId, workspace, mapped("agents", o.row.author_agent_id), source.origin, Number(o.row.server_at_ms), Number(o.row.server_at_ms), skillId);
            }
            // Preserve the original structured bytes/digest/compiler; the new content is a read projection only.
            const c = contentSchema.parse({ title: old.title || "Imported native revision", purpose: old.purpose ?? "", trigger: old.when_to_use ? [old.when_to_use] : [],
              procedure: old.procedure ?? [], failure_modes: old.failure_modes ?? [], compatibility: old.dependencies ?? [], requested_capabilities: old.permissions ?? [] });
            target.query(`INSERT INTO skill_draft_revisions(id,workspace_id,actor_id,origin_instance_id,created_at_ms,draft_id,revision_no,parent_revision_id,
              source_refs,content_json,content_digest,compiler_version,missing_requirements,original_revision_id,original_digest,original_compiler_version,legacy_runbook_json)
              VALUES (?,?,?,?,?,?,?,?,'[]',?,?,?,?,?,?,?,?)`).run(localId, workspace, mapped("agents", o.row.author_agent_id), source.origin, Number(o.row.server_at_ms), draftId,
              Number(o.row.revision), mapped("draft_revisions", o.row.parent_revision_id), canonical(c), contentDigest(c), COMPILER, canonical(missingRequirements(c)), o.id, String(o.row.content_digest), String(o.row.compiler_version), String(o.row.content_json));
            target.query("UPDATE skill_drafts SET revision=?,head_revision_id=?,updated_at_ms=? WHERE id=?").run(Number(o.row.revision), localId, Number(o.row.server_at_ms), draftId);
            const approved = original.query("SELECT 1 FROM revision_approvals WHERE draft_revision_id=?").get(o.id) ||
              original.query("SELECT 1 FROM draft_decisions WHERE draft_revision_id=? AND decision='approved'").get(o.id);
            if (approved) {
              target.query(`INSERT INTO skill_versions(id,workspace_id,actor_id,origin_instance_id,created_at_ms,skill_id,version_label,candidate_digest,content_digest,package_digest,
                original_format,manifest_schema,source_revision_id,lineage_refs,license,descriptor_json,members_json,package_bytes,status)
                VALUES (?,?,?,?,?,?,?,?,?,?,'legacy_revision','skillonomia-native',?,'[]','unknown',?,'{}',?,'legacy_revision')`)
                .run(`legacy-${localId}`, workspace, mapped("agents", o.row.author_agent_id), source.origin, Number(o.row.server_at_ms), skillId,
                  `legacy-${Number(o.row.revision)}`, String(o.row.content_digest).replace(/^sha256:/, ""), String(o.row.content_digest).replace(/^sha256:/, ""),
                  digest(String(o.row.content_json)), localId, String(o.row.content_json), Buffer.from(String(o.row.content_json)));
            }
          } else {
            archive(o, /grant|key|membership|assignment/.test(o.table) ? "migration_review_required_no_new_authority" : "immutable_P2_history"); continue;
          }
          archive(o, "canonical_original_preserved_no_credential_elevation"); continue;
        }
        // Qoopia fields and temporal flags are copied from canonical rows, never reconstructed from FTS.
        const columns = target.query(`PRAGMA table_info(${quoted(o.table)})`).all() as { name: string }[];
        const canonicalRow = normalized32 && o.table === "notes"
          ? normalized32.query("SELECT * FROM notes WHERE id=?").get(o.id) as Row : o.row;
        const data: Row = Object.fromEntries(Object.entries(canonicalRow).filter(([name]) => name !== "__source_rowid__"));
        if ("id" in data) data.id = localId;
        if ("workspace_id" in data) data.workspace_id = workspace;
        for (const fk of original.query(`PRAGMA foreign_key_list(${quoted(o.table)})`).all() as { from: string; table: string; to: string }[]) {
          if (fk.to === "id" && data[fk.from] != null) data[fk.from] = mapped(fk.table, o.row[fk.from]);
        }
        if (o.table === "entity_links") {
          data.source_entity_id=mapped("entity_pages",o.row.source_entity_id);
          data.target_entity_id=mapped("entity_pages",o.row.target_entity_id);
        }
        if (o.table === "notes") data.session_id = mapped("sessions", o.row.session_id);
        if (o.table === "summaries") {
          for (const field of ["msg_start_id", "msg_end_id"]) {
            const shifted = Number(o.row[field]) + (integerOffsets.get("session_messages") ?? 0);
            if (!Number.isSafeInteger(shifted)) throw new QoopiaError("QUARANTINED", "Summary message range cannot be remapped safely");
            data[field] = shifted;
          }
        }
        if (o.table === "agents") { data.active = 0; data.api_key_hash = digest(randomUUID()); data.tool_profile = "read-only"; }
        if (o.table === "users" && data.api_key_hash) data.api_key_hash = digest(randomUUID());
        // Active wake/outbox/OAuth effects and old replay rows are historical, not executable authorization.
        if (columns.length === 0 || /oauth|consent|wake|outbox|idempotency|token/i.test(o.table)) {
          localTypes.set(key(o.table, o.id), "migration_origins"); archive(o, "paused_legacy_protocol"); continue;
        }
        if (o.table === "entity_pages" && target.query("SELECT 1 FROM entity_pages WHERE workspace_id=? AND slug=?").get(workspace, data.slug!)) {
          data.slug = `${String(data.slug)}-import-${digest(source.origin + o.id).slice(0, 12)}`; collisions.push({ table: o.table, reason: "Slug collision preserved" });
        }
        const names = Object.keys(data);
        if (names.some((n) => !columns.some((c) => c.name === n))) throw new QoopiaError("UNSUPPORTED_SCHEMA", "Target cannot represent every source field");
        target.query(`INSERT INTO ${quoted(o.table)} (${names.map(quoted).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((n) => data[n]!));
        if (o.table === "entity_pages" && data.type === "skill") {
          const metadata = JSON.parse(String(data.metadata)), actor = actorFor(workspace), draftId = randomUUID(), revisionId = randomUUID();
          const c = contentSchema.parse({ title: String(data.title), purpose: String(data.summary ?? ""), trigger: metadata.trigger_conditions ?? [],
            procedure: metadata.exact_steps ?? [], verification: metadata.verification_gates ?? [], failure_modes: metadata.failure_modes ?? [], rollback: metadata.rollback ?? "", compatibility: metadata.prerequisites ?? [] });
          const now = Date.parse(String(data.updated_at));
          if (!Number.isSafeInteger(now)) throw new QoopiaError("QUARANTINED", "Ambiguous source timestamp; original remains untouched");
          target.query(`INSERT INTO skill_drafts(id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,skill_id,revision,head_revision_id) VALUES (?,?,?,?,?,?,?,1,?)`)
            .run(draftId, workspace, actor, source.origin, now, now, localId, revisionId);
          target.query(`INSERT INTO skill_draft_revisions(id,workspace_id,actor_id,origin_instance_id,created_at_ms,draft_id,revision_no,source_refs,content_json,content_digest,compiler_version,missing_requirements,legacy_runbook_json)
            VALUES (?,?,?,?,?,?,1,'[]',?,?,?,?,?)`).run(revisionId, workspace, actor, source.origin, now, draftId, canonical(c), contentDigest(c), COMPILER, canonical(missingRequirements(c)), o.bytes.toString());
        }
        archive(o, "canonical_original_preserved");
      }
      if (normalized32) {
        for (const row of normalized32.query("SELECT * FROM note_temporal_provenance").all() as Row[]) {
          const values = { ...row, note_id: mapped("notes", row.note_id), workspace_id: mapped("workspaces", row.workspace_id) };
          const names = Object.keys(values);
          target.query(`INSERT INTO note_temporal_provenance (${names.map(quoted).join(",")}) VALUES (${names.map(() => "?").join(",")})`)
            .run(...names.map((name) => (values as Row)[name]!));
        }
      }
      if (target.query("PRAGMA foreign_key_check").all().length) throw new QoopiaError("QUARANTINED", "Target foreign-key reconciliation failed; transaction rolled back");
      const count = target.query("SELECT count(*) AS n FROM migration_origins WHERE origin_instance_id=?").get(source.origin) as { n: number };
      if (count.n !== originals.length) throw new QoopiaError("INTERNAL", "Incomplete origin mapping");
      const report = { ...plan, mapped_rows: count.n, mapping_coverage: 1, collisions, source_unchanged: true,
        stage: "fixture_verified", cutover: "not_run_P3", credentials: "inactive_reenrollment_required", dormant_history: "immutable_P2_archive" };
      target.query("UPDATE migration_runs SET stage='fixture_verified',last_batch=1,report_json=? WHERE origin_instance_id=?")
        .run(canonical(report), source.origin);
      return report;
    }).immediate();
  } finally { normalized32?.close(); original.close(); }
}
