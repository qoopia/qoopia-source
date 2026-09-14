#!/usr/bin/env bun
import {qualificationAmbientRoot} from "../tests/helpers/p2-safe-env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { dataFile, readCurrent } from "../src/delivery/operations.ts";
import { sha256File } from "../src/services/backup.ts";
import { importSource, preflightSource, type SourcePlan, type SourceSnapshot } from "../src/migrations/source-adapters.ts";
import { ownerFixture } from "../tests/helpers/p1-fixtures.ts";
import { qoopiaSource, representativeQoopiaSource, representativeSkillonomiaSource, skillonomiaSource } from "../tests/helpers/source-fixtures.ts";

const MAX_SELF_CHECK_BYTES = 32 * 1024 * 1024;
const MAX_SELF_CHECK_MS = 60_000;
const FIXED_TIME = "2026-01-01T00:00:00.000Z";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function freezeQoopia(source: SourceSnapshot): SourceSnapshot {
  const database = Database.deserialize(source.bytes);
  try {
    // The reused fixture leaves these defaults clock-derived; freeze only fixture values.
    database.query("UPDATE workspaces SET created_at=?, updated_at=?").run(FIXED_TIME, FIXED_TIME);
    database.query("UPDATE agents SET created_at=? WHERE id='01BBBBBBBBBBBBBBBBBBBBBBBB'").run(FIXED_TIME);
    database.query("UPDATE entity_pages SET created_at=?, updated_at=?").run(FIXED_TIME, FIXED_TIME);
    return { ...source, bytes: database.serialize() };
  } finally {
    database.close();
  }
}

function deterministicSources(): SourceSnapshot[] {
  return [freezeQoopia(qoopiaSource(32)), freezeQoopia(qoopiaSource(35)), skillonomiaSource()];
}

function representativeSources(): SourceSnapshot[] {
  return [freezeQoopia(representativeQoopiaSource(32)), freezeQoopia(representativeQoopiaSource(35)), representativeSkillonomiaSource()];
}

function materialize(root: string, sources = deterministicSources()) {
  mkdirSync(root, { recursive: false, mode: 0o700 });
  const plans: Record<string, SourcePlan> = {};
  for (const source of sources) {
    const name = `${source.kind}-${source.origin}`;
    const dbPath = join(root, `${name}.sqlite`);
    writeFileSync(dbPath, source.bytes, { mode: 0o600 });
    const blobs = new Map<string, Buffer>();
    for (const [ref, bytes] of source.blobs ?? []) {
      const blobPath = join(root, `${name}-${ref}`);
      writeFileSync(blobPath, bytes, { mode: 0o600 });
      blobs.set(ref, readFileSync(blobPath));
    }
    const persisted: SourceSnapshot = { ...source, bytes: readFileSync(dbPath), blobs };
    const database = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(database.query("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
      assert.deepEqual(database.query("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
    }
    plans[name] = preflightSource(persisted); // exact supported schema/field/package verification
  }
  const files = readdirSync(root).sort().map((name) => {
    const bytes = readFileSync(join(root, name));
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    plans,
    files,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    corpus_sha256: sha256(JSON.stringify(files)),
  };
}

const REQUIRED_QOOPIA = ["workspaces", "agents", "entity_pages", "notes", "note_relations", "sessions", "session_messages", "summaries", "files"];
const REQUIRED_SKILLONOMIA = ["workspaces", "agents", "workspace_memberships", "signing_keys", "skills", "skill_access_grants", "skill_versions", "captures", "draft_revisions", "revision_approvals", "skill_assignments", "skill_assignment_events", "agent_sessions", "session_loadouts", "session_loadout_entries", "runtime_receipts", "session_closures", "session_outcomes", "transparency_log"];
const QOOPIA_EXCLUSIONS: Record<string, string> = {
  activity: "optional audit history uses the same generic exact-copy branch represented by required canonical tables",
  agent_comm_delivery_receipts: "schema32-only optional delivery state uses the same generic exact-copy branch represented by required canonical tables",
  agent_comm_messages: "optional transport history uses the same generic exact-copy branch represented by required canonical tables",
  agent_comm_sessions: "optional transport history uses the same generic exact-copy branch represented by required canonical tables",
  agent_wake_events: "paused legacy wake protocol; archived, never reactivated",
  claude_code_agents: "optional legacy runtime registration uses the same generic exact-copy branch represented by required canonical tables",
  consent_tickets: "ephemeral authorization protocol; archived, never credential-elevated",
  entity_embeddings: "derived search index; rebuildable from canonical entities",
  entity_links: "optional knowledge graph history uses the same generic exact-copy branch represented by required canonical tables",
  extraction_candidates: "optional extraction workflow history uses the same generic exact-copy branch represented by required canonical tables",
  extraction_runs: "optional extraction workflow history uses the same generic exact-copy branch represented by required canonical tables",
  idempotency_keys: "ephemeral replay cache; archived, never executable",
  memory_event_outbox: "paused delivery outbox; archived, never replayed",
  memory_lifecycle: "optional derived recall counters use the same generic exact-copy branch represented by required canonical tables",
  note_provenance: "optional source annotation uses the same generic exact-copy branch represented by required canonical tables",
  note_temporal_provenance: "schema35 migration provenance uses the same generic exact-copy branch represented by required canonical tables; schema32 normalization is separately exercised",
  notes_embeddings: "derived search index; rebuildable from canonical notes",
  oauth_clients: "legacy credential protocol; archived, never credential-elevated",
  oauth_tokens: "legacy credential protocol; archived, never credential-elevated",
  recall_feedback: "optional recall telemetry uses the same generic exact-copy branch represented by required canonical tables",
  recall_log: "optional recall telemetry uses the same generic exact-copy branch represented by required canonical tables",
  recall_trace_items: "optional recall telemetry uses the same generic exact-copy branch represented by required canonical tables",
  recall_traces: "optional recall telemetry uses the same generic exact-copy branch represented by required canonical tables",
  sync_applied_hashes: "internal legacy sync bookkeeping; historical archive only",
  sync_conflict_queue: "internal legacy sync bookkeeping; historical archive only",
  users: "legacy compatibility identity projection; historical archive only",
  wake_slo_probes: "optional operational probe history uses the same generic exact-copy branch represented by required canonical tables",
};
const SKILLONOMIA_EXCLUSIONS: Record<string, string> = {
  activity_log: "optional audit history outside the verified transparency chain",
  adoption_receipts: "optional remote adoption workflow; archived for review without authority",
  adoption_requests: "optional remote adoption workflow; archived for review without authority",
  approvals: "optional publication/adoption decision history; archived immutable",
  assignment_events: "legacy package-assignment workflow; archived for review without authority",
  assignment_observations: "optional legacy assignment telemetry; archived immutable",
  assignments: "legacy transfer assignment; archived for review without authority",
  attestations: "optional package attestation; archived immutable",
  console_ticket_uses: "ephemeral console authentication history; archived without credentials",
  console_tickets: "ephemeral console authentication history; archived without credentials",
  draft_decisions: "alternative approval history; revision_approvals is the representative branch",
  draft_events: "optional draft event history; archived immutable",
  idempotency_keys: "ephemeral replay cache; archived without replay",
  idempotency_request_digests: "derived replay digest; archived without replay",
  lint_reports: "optional package qualification history; archived immutable",
  observed_records: "optional runtime telemetry; archived immutable",
  outcome_conflicts: "optional conflict branch; normal worked outcome is represented",
  owner_session_revocations: "ephemeral owner authentication history; archived without credentials",
  owner_sessions: "ephemeral owner authentication history; archived without credentials",
  ratings: "optional adoption feedback; archived immutable",
  receipt_events: "legacy adoption receipt history; runtime receipt branch is represented",
  reviews: "optional package review; signed immutable package verification is represented",
  revision_comparisons: "optional post-failure comparison branch",
  revision_sources: "optional post-failure revision branch",
  runtime_observations: "legacy discovery telemetry; immutable session receipt is represented",
  transfer_grants: "remote transfer authority is never activated during migration",
  transfers: "remote transfer history is archived for review without authority",
  webhooks: "legacy transport credential/endpoint is archived and paused",
  api_keys: "legacy credentials are archived and never imported as active authority",
};
const VARIANTS: Record<string, Array<[string, string, "both" | "nonnull" | "distinct"]>> = {
  qoopia: [["agents", "last_seen", "both"], ["agents", "active", "distinct"], ["sessions", "agent_id", "both"], ["sessions", "title", "both"], ["sessions", "task_bound_id", "both"], ["session_messages", "agent_id", "both"], ["session_messages", "token_count", "both"], ["session_messages", "ingest_uuid", "both"], ["files", "text_excerpt", "both"], ["notes", "project_id", "both"], ["notes", "task_bound_id", "both"], ["notes", "session_id", "both"], ["notes", "deleted_at", "both"]],
  skillonomia: [["agents", "tool_profile", "both"], ["agents", "merged_into_agent_id", "both"], ["agents", "passport_ref", "both"], ["api_keys", "revoked_at_ms", "both"], ["signing_keys", "revoked_at_ms", "nonnull"], ["signing_keys", "secret_ref", "nonnull"], ["skill_access_grants", "grantee_workspace_id", "both"], ["skill_access_grants", "grantee_agent_id", "both"], ["runtime_receipts", "invocation_ref", "nonnull"], ["session_outcomes", "runtime_session_ref", "nonnull"], ["session_outcomes", "invocation_receipt_id", "nonnull"]],
};
const QOOPIA35_VARIANTS: Array<[string, string, "both"]> = ["valid_from", "valid_until", "invalidated_at", "subject_key", "supersedes_id", "created_at_ms", "valid_from_ms", "valid_until_ms", "invalidated_at_ms"]
  .map((field) => ["notes", field, "both"]);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function coverage(root: string, files: Array<{ name: string }>) {
  return Object.fromEntries(files.filter((file) => file.name.endsWith(".sqlite")).map((file) => {
    const source = file.name.slice(0, -".sqlite".length), kind = source.startsWith("skillonomia-") ? "skillonomia" : "qoopia";
    const database = new Database(join(root, file.name), { readonly: true });
    try {
      const tables = database.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string; sql: string }>;
      const virtual = tables.filter((table) => /CREATE VIRTUAL TABLE/i.test(table.sql)).map((table) => table.name);
      const isDerived = (name: string) => virtual.some((v) => name === v || name.startsWith(`${v}_`));
      const canonicalTables = tables.filter((table) => table.name !== "schema_versions" && !isDerived(table.name));
      const required = kind === "qoopia" ? REQUIRED_QOOPIA : REQUIRED_SKILLONOMIA;
      const exclusions = kind === "qoopia" ? QOOPIA_EXCLUSIONS : SKILLONOMIA_EXCLUSIONS;
      const classificationGaps = canonicalTables.map((t) => t.name).filter((name) => !required.includes(name) && !exclusions[name]);
      const staleExclusions = Object.keys(exclusions).filter((name) => !canonicalTables.some((t) => t.name === name));
      const requiredTableGaps: string[] = [], requiredFieldGaps: string[] = [], optionalNullOnlyFields: string[] = [], excludedTablesPopulated: string[] = [], excludedTablesEmpty: string[] = [];
      let declaredFields = 0, canonicalFields = 0, mappedFields = 0, representativeFields = 0, representativeFieldsWithValues = 0;
      const tableDispositions: Record<string, string> = {};
      for (const table of tables) {
        const fields = database.query(`PRAGMA table_info(${quote(table.name)})`).all() as Array<{ name: string; notnull: number; pk: number }>;
        declaredFields += fields.length;
        if (table.name !== "schema_versions" && !isDerived(table.name)) canonicalFields += fields.length;
        tableDispositions[table.name] = table.name === "schema_versions" ? "adapter_schema_version_input" : isDerived(table.name) ? "derived_fts_internal_not_canonical" :
          required.includes(table.name) ? (kind === "qoopia" ? "representative_exact_copy" : ["agents", "skills", "skill_versions", "draft_revisions"].includes(table.name) ? "representative_projected_plus_immutable_original" : "representative_immutable_original") :
            kind === "skillonomia" ? "excluded_representative_immutable_history_no_new_authority" : /oauth|consent|wake|outbox|idempotency|token/i.test(table.name) ? "excluded_representative_archived_paused_protocol" : "excluded_representative_same_generic_exact_copy_branch";
        mappedFields += fields.length; // inspect() validates every declared field; encodedRow() archives every canonical value.
        if (!required.includes(table.name)) {
          if (canonicalTables.some((canonicalTable) => canonicalTable.name === table.name)) {
            const count = (database.query(`SELECT count(*) AS n FROM ${quote(table.name)}`).get() as { n: number }).n;
            (count ? excludedTablesPopulated : excludedTablesEmpty).push(table.name);
          }
          continue;
        }
        representativeFields += fields.length;
        const count = (database.query(`SELECT count(*) AS n FROM ${quote(table.name)}`).get() as { n: number }).n;
        if (!count) requiredTableGaps.push(table.name);
        representativeFieldsWithValues += fields.map((field) => database.query(`SELECT count(${quote(field.name)}) AS n FROM ${quote(table.name)}`).get() as { n: number })
          .filter((result) => result.n > 0).length;
        for (const field of fields.filter((f) => f.notnull || f.pk)) {
          const populated = (database.query(`SELECT count(${quote(field.name)}) AS n FROM ${quote(table.name)}`).get() as { n: number }).n;
          if (!populated) requiredFieldGaps.push(`${table.name}.${field.name}`);
        }
        for (const field of fields.filter((f) => !f.notnull && !f.pk)) {
          const populated = (database.query(`SELECT count(${quote(field.name)}) AS n FROM ${quote(table.name)}`).get() as { n: number }).n;
          if (!populated) optionalNullOnlyFields.push(`${table.name}.${field.name}`);
        }
      }
      const variants = [...VARIANTS[kind], ...(source === "qoopia-q-35" ? QOOPIA35_VARIANTS : [])];
      const variantGaps = variants.flatMap(([table, field, mode]) => {
        if (!canonicalTables.some((t) => t.name === table)) return [`${table}.${field}:absent`];
        const counts = database.query(`SELECT count(*) AS total,count(${quote(field)}) AS nonnull,count(DISTINCT ${quote(field)}) AS distinct_values FROM ${quote(table)}`).get() as { total: number; nonnull: number; distinct_values: number };
        return counts.nonnull === 0 || (mode === "both" && counts.nonnull === counts.total) || (mode === "distinct" && counts.distinct_values < 2) ? [`${table}.${field}:${mode}`] : [];
      });
      const privilegeGaps = kind === "skillonomia"
        ? ["owner", "admin", "reviewer", "member"].filter((role) => !database.query("SELECT 1 FROM workspace_memberships WHERE role=? LIMIT 1").get(role))
        : ["standard", "admin", "service"].filter((type) => !database.query("SELECT 1 FROM agents WHERE type=? LIMIT 1").get(type));
      const complete = !classificationGaps.length && !requiredTableGaps.length && !requiredFieldGaps.length && !variantGaps.length && !privilegeGaps.length && mappedFields === declaredFields;
      return [source, {
        canonical_tables: canonicalTables.length,
        representative_tables_required: required,
        representative_tables_populated: required.length - requiredTableGaps.length,
        required_table_gaps: requiredTableGaps,
        required_field_gaps: requiredFieldGaps,
        meaningful_nullable_variant_gaps: variantGaps,
        privilege_values_missing: privilegeGaps,
        declared_schema_fields: declaredFields,
        canonical_fields: canonicalFields,
        representative_declared_fields: representativeFields,
        representative_fields_with_values: representativeFieldsWithValues,
        mapping_disposition_fields: mappedFields,
        field_mapping_coverage: mappedFields / declaredFields,
        optional_null_only_fields_not_promoted_to_requirements: optionalNullOnlyFields,
        explicit_table_exclusions: Object.fromEntries(Object.entries(exclusions).filter(([name]) => canonicalTables.some((t) => t.name === name))),
        excluded_tables_populated: excludedTablesPopulated,
        excluded_tables_empty: excludedTablesEmpty,
        table_dispositions: tableDispositions,
        classification_gaps: classificationGaps,
        stale_exclusions_ignored_for_other_supported_schema: staleExclusions,
        representative_coverage_complete: complete,
      }];
    } finally {
      database.close();
    }
  }));
}

function selfCheck() {
  const started = performance.now();
  const outer = mkdtempSync(join(tmpdir(), "qoopia-p3-materializer-"));
  try {
    const first = materialize(join(outer, "a"));
    const second = materialize(join(outer, "b"));
    assert.deepEqual(second, first, "two independent materializations must be byte-identical");
    const disposableBytes = first.total_bytes + second.total_bytes;
    assert(disposableBytes < MAX_SELF_CHECK_BYTES, `self-check exceeded ${MAX_SELF_CHECK_BYTES} bytes`);
    const elapsedMs = Math.round(performance.now() - started);
    assert(elapsedMs < MAX_SELF_CHECK_MS, `self-check exceeded ${MAX_SELF_CHECK_MS} ms`);
    console.log(JSON.stringify({
      status: "PASS_SMALL_P3_QUALIFICATION_CORPUS_MATERIALIZER",
      scope: "schema-compatible deterministic source fixture materialization only; not representative/full-field gate coverage",
      independent_materializations: 2,
      corpus_sha256: first.corpus_sha256,
      per_source: Object.fromEntries(Object.entries(first.plans).map(([name, plan]) => [name, {
        schema: plan.source_schema,
        canonical_rows: plan.canonical_rows,
        nonzero_table_counts: Object.fromEntries(Object.entries(plan.counts).filter(([, count]) => count > 0)),
        source_digest: plan.source_digest,
        immutable_packages: plan.immutable_packages,
        transparency_log_rows: plan.tlog_rows,
      }])),
      files: first.files,
      one_materialization_bytes: first.total_bytes,
      disposable_bytes: disposableBytes,
      elapsed_ms: elapsedMs,
      integrity_check: "ok",
      foreign_key_violations: 0,
      deterministic_output_equal: true,
    }));
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}

export function finalCampaignPlan() {
  return {
    status: "PLAN_ONLY_FINAL_RC_NOT_MINTED_WORKLOADS_NOT_EXECUTED",
    admission: [
      "reviewed clean SHA/version/schema frozen",
      "publisher release authorization binds exact SHA, target, public key and approved legal-materials digest",
      "Darwin Developer ID Application identity and notary keychain profile available to custodian",
      "production Ed25519 signer available by executable reference and public fingerprint independently pinned",
      "final SBOM/notices are complete and reviewed; authenticated upstream Bun material is not legal release authorization",
      "immutable channel selected; final RC binary/manifest/assets/config hashes pinned",
    ],
    phases: [
      { order: 1, gates: ["T-21", "T-28"], action: "build/sign/notarize exact clean-SHA Darwin RC and signed Linux RC, then verify artifact, provenance, notices and immutable-channel readback" },
      { order: 2, gates: ["T-26", "T-25"], action: "run existing lifecycle/security drivers on exact RC" },
      { order: 3, gates: ["T-01", "T-16"], action: "run clean-user native/offline matrix with Claude Code and Codex" },
      { order: 4, gates: ["T-23", "T-24"], action: "run existing representative migration/cutover/key-loss drivers against sanctioned disposable source" },
      { order: 5, gates: ["T-14", "T-27"], action: "run existing recovery/fault drivers, including bounded-deadline raw timing and 5 GiB on sanctioned storage" },
      { order: 6, gates: ["T-29"], action: "run 100k notes/1M messages, 5 clients/30 min and 100x10 MiB/100-file schedule once on named hardware" },
      { order: 7, gates: ["P3 exit"], action: "independent clean-machine review; any mandatory RED/unknown blocks exit" },
    ],
    reuse: {
      representative_source_driver: "bun run scripts/p3-qualification-materializer.ts --coverage-check",
      recovery_scale_driver: "bun run scripts/p3-qualification-materializer.ts --recovery-scale ...",
      artifact_driver: "bun run scripts/p3-artifact-check.ts --bundle <exact-final-rc-bundle>",
      signing_driver: "bun run scripts/build-bundle.ts --publisher --out <new-absolute-out> --publisher-public-key <absolute-pem> --signer <absolute-custodian-executable> --release-authorization <absolute-json>",
    },
    workloads: { t29_notes: 100_000, t29_messages: 1_000_000, t14_restore_bytes: 5 * 1024 ** 3 },
    stop_rule: "execute phases in order; stop at the first mandatory RED/unknown and do not relabel dirty-candidate evidence as final-RC evidence",
    prohibited_now: ["workload execution", "VM launch", "fixture creation", "full suite", "candidate rebuild", "production target", "QOOPIA_ROOT", "user home"],
    next_executable_command_after_external_inputs: "bun run scripts/build-bundle.ts --publisher --out <new-absolute-out> --publisher-public-key <absolute-pem> --signer <absolute-custodian-executable> --release-authorization <absolute-json>",
  } as const;
}

function plan() {
  console.log(JSON.stringify(finalCampaignPlan()));
}

function migrationRoundtrips(sources: SourceSnapshot[]) {
  const snapshotDigest = (source: SourceSnapshot) => sha256(JSON.stringify({
    database: sha256(source.bytes),
    blobs: [...(source.blobs ?? [])].map(([ref, bytes]) => [ref, sha256(bytes)]).sort(([a], [b]) => a.localeCompare(b)),
  }));
  const byOrigin = Object.fromEntries(sources.map((source) => [source.origin, source]));
  const journeys: Array<[string, SourceSnapshot[]]> = [
    ["qoopia32-only", [byOrigin["q-32"]!]],
    ["qoopia35-only", [byOrigin["q-35"]!]],
    ["skillonomia19-only", [byOrigin["s-19"]!]],
    ["both-q35-s19-same-owner", [byOrigin["q-35"]!, byOrigin["s-19"]!]],
    ["new-user-no-source", []],
  ];
  return journeys.map(([journey, inputs]) => {
    const { database, auth } = ownerFixture();
    try {
      const reports = inputs.map((source) => {
        const before = snapshotDigest(source), plan = preflightSource(source);
        const report = importSource(database, source, { build_sha: "1fbfdfc0de7c01c9913eb48e7b948a9808baf2bc", workspace_map: { "01AAAAAAAAAAAAAAAAAAAAAAAA": auth.workspace_id } });
        assert.equal(report.mapping_coverage, 1);
        assert.equal(report.mapped_rows, plan.canonical_rows);
        assert.equal(snapshotDigest(source), before);
        assert.equal(preflightSource(source).source_digest, plan.source_digest);
        assert.equal((database.query("SELECT count(*) AS n FROM migration_origins WHERE origin_instance_id=?").get(source.origin) as { n: number }).n, plan.canonical_rows);
        const importedAgents = database.query(`SELECT a.active,a.tool_profile FROM migration_origins m JOIN agents a ON a.id=m.local_id
          WHERE m.origin_instance_id=? AND m.source_type='agents'`).all(source.origin) as Array<{ active: number; tool_profile: string }>;
        assert(importedAgents.length > 0 && importedAgents.every((agent) => agent.active === 0 && agent.tool_profile === "read-only"));
        if (source.kind === "skillonomia") {
          const authorityHistory = database.query(`SELECT disposition FROM migration_origins WHERE origin_instance_id=?
            AND (source_type LIKE '%grant%' OR source_type LIKE '%key%' OR source_type LIKE '%membership%' OR source_type LIKE '%assignment%')`).all(source.origin) as Array<{ disposition: string }>;
          assert(authorityHistory.length > 0 && authorityHistory.every((row) => row.disposition === "migration_review_required_no_new_authority"));
        }
        return { origin: source.origin, preflight_rows: plan.canonical_rows, mapped_rows: report.mapped_rows, mapping_coverage: report.mapping_coverage,
          source_snapshot_sha256_before: before, source_snapshot_sha256_after: snapshotDigest(source), source_digest_before: plan.source_digest,
          source_digest_after: preflightSource(source).source_digest, source_unchanged: true, imported_agents_inactive_read_only: true,
          authority_history_created_no_new_authority: source.kind === "skillonomia" ? true : "not_applicable", collisions: report.collisions };
      });
      const serialized = database.serialize();
      assert(serialized.byteLength < MAX_SELF_CHECK_BYTES, "one disposable migrated database exceeded 32 MiB");
      const reopened = Database.deserialize(serialized, true);
      try {
        assert.deepEqual(reopened.query("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
        assert.deepEqual(reopened.query("PRAGMA foreign_key_check").all(), []);
        for (const report of reports) assert.equal((reopened.query("SELECT count(*) AS n FROM migration_origins WHERE origin_instance_id=?").get(report.origin) as { n: number }).n, report.mapped_rows);
      } finally { reopened.close(); }
      return { journey, reports, serialized_bytes: serialized.byteLength, roundtrip_integrity: "ok", foreign_key_violations: 0 };
    } finally { database.close(); }
  });
}

function coverageCheck() {
  const started = performance.now();
  const outer = mkdtempSync(join(tmpdir(), "qoopia-p3-coverage-"));
  try {
    const sourcesInput = representativeSources();
    const corpus = materialize(join(outer, "corpus"), sourcesInput);
    assert(corpus.total_bytes < MAX_SELF_CHECK_BYTES, "representative corpus exceeded 32 MiB");
    const sources = coverage(join(outer, "corpus"), corpus.files);
    const migrations = migrationRoundtrips(sourcesInput);
    const complete = Object.values(sources).every((source) => source.representative_coverage_complete);
    console.log(JSON.stringify({
      status: complete ? "PASS_BOUNDED_REPRESENTATIVE_SOURCE_COVERAGE_AND_MAPPING" : "INCOMPLETE_REPRESENTATIVE_SOURCE_COVERAGE",
      scope: "bounded persisted-source representative row/required-field/nullable-variant/origin/privilege coverage plus disposable migration roundtrips; not full P3/T-14/T-23 qualification",
      corpus_sha256: corpus.corpus_sha256,
      corpus_bytes: corpus.total_bytes,
      cap_bytes: MAX_SELF_CHECK_BYTES,
      origins: Object.keys(sources).sort(),
      sources,
      migration_roundtrips: migrations,
      elapsed_ms: Math.round(performance.now() - started),
      remaining_missing_cells: complete ? [
        "optional/derived/internal tables are not representative requirements; exact populated/empty status and per-table rationale are emitted",
        "unknown source table/column/schema10 STOP remains covered by tests/p1-migration.test.ts, not seeded into a GREEN corpus",
        "5 GiB restore, other-user/OS, final-RC and full P3 campaign cells remain out of this bounded pass",
      ] : ["resolve only emitted required table/field/variant/privilege/classification gaps"],
    }));
    if (!complete) process.exitCode = 2;
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}

const RECOVERY_BYTES = 5 * 1024 ** 3;
const RECOVERY_CHUNK_BYTES = 4 * 1024 ** 2;
const RECOVERY_METADATA_RESERVE = 1024 ** 3;
const RECOVERY_PREFIX = "qoopia-p3-recovery-scale-";
const RECOVERY_SCALE_BYTES = new Set([256 * 1024 ** 2, 1024 ** 3, RECOVERY_BYTES]);

export type RecoveryExecutionIdentity = { platform: string; arch: string; uid: number | undefined; platform_uuid: string };
export const SANCTIONED_RECOVERY_GUEST: RecoveryExecutionIdentity = {
  platform: "darwin",
  arch: "arm64",
  uid: 501,
  platform_uuid: "D7AC85CF-6DB1-55B2-AB59-BD69A7B5D36D",
};

function canonicalRecoveryIdentity(): RecoveryExecutionIdentity | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const platformUuid = result.status === 0 ? result.stdout.match(/"IOPlatformUUID" = "([0-9A-F-]+)"/)?.[1] : undefined;
  return platformUuid ? { platform: process.platform, arch: process.arch, uid: process.getuid?.(), platform_uuid: platformUuid } : undefined;
}

export function assertRecoveryExecutionTarget(mode: string | undefined, bytes: number, identity: RecoveryExecutionIdentity | undefined) {
  if (!mode) throw new Error("REFUSED_EXECUTION_MODE_REQUIRED");
  if (mode === "local-small-selfcheck") {
    if (bytes >= MAX_SELF_CHECK_BYTES) throw new Error("REFUSED_LOCAL_MODE_FOR_SCALE");
    return mode;
  }
  if (mode !== "sanctioned-guest-scale") throw new Error("REFUSED_EXECUTION_MODE");
  if (!RECOVERY_SCALE_BYTES.has(bytes)) throw new Error("REFUSED_SCALE_BYTES");
  if (!identity) throw new Error("REFUSED_SANCTIONED_GUEST_IDENTITY_MISSING");
  if (identity.platform !== SANCTIONED_RECOVERY_GUEST.platform || identity.arch !== SANCTIONED_RECOVERY_GUEST.arch || identity.uid !== SANCTIONED_RECOVERY_GUEST.uid || identity.platform_uuid !== SANCTIONED_RECOVERY_GUEST.platform_uuid) {
    throw new Error("REFUSED_SANCTIONED_GUEST_IDENTITY");
  }
  return mode;
}

type BundleManifest = { format: string; signing: string; target: string; build_sha: string; source_digest: string; members: Record<string, { size: number; sha256: string }> };
type FileRow = { id: string; workspace_id: string; owner_agent_id: string; folder: string; filename: string; mime: string; size: number; sha256: string; content: Uint8Array; text_excerpt: string | null; uploaded_by_agent_id: string; created_at: string };

function option(args: string[], name: string) {
  const matches = args.flatMap((arg, index) => arg === `--${name}` ? [index] : []);
  if (matches.length !== 1 || !args[matches[0]! + 1] || args[matches[0]! + 1]!.startsWith("--")) throw new Error(`--${name} required exactly once`);
  return args[matches[0]! + 1]!;
}

function below(path: string, parent: string) {
  const child = relative(parent, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertNoSymlinkComponents(path: string) {
  let cursor = resolve(path);
  const existing: string[] = [];
  while (!existsSync(cursor)) { existing.push(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  for (;;) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("REFUSED_TARGET_SYMLINK");
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return existing;
}

function validateRecoveryTarget(input: string, selfCheckBytes?: number) {
  if (qualificationAmbientRoot) throw new Error("REFUSED_AMBIENT_QOOPIA_ROOT");
  if (!isAbsolute(input)) throw new Error("REFUSED_TARGET_NOT_ABSOLUTE");
  const target = resolve(input), repo = realpathSync(resolve(import.meta.dir, "..")), home = realpathSync(homedir());
  assertNoSymlinkComponents(target);
  if (!basename(target).startsWith(RECOVERY_PREFIX)) throw new Error(`REFUSED_TARGET_NAME: basename must start ${RECOVERY_PREFIX}`);
  if (target === home || below(target, home) || target === repo || below(target, repo) || below(repo, target)) throw new Error("REFUSED_TARGET_HOME_OR_REPOSITORY");
  if (existsSync(target) && (!lstatSync(target).isDirectory() || readdirSync(target).length)) throw new Error("REFUSED_TARGET_NONEMPTY");
  if (selfCheckBytes !== undefined && existsSync(target)) throw new Error("REFUSED_SELF_CHECK_TARGET_MUST_BE_NEW");
  return target;
}

function invoke(binary: string, args: string[], env: Record<string, string>, timeout: number, events: Array<Record<string, unknown>>) {
  const result = spawnSync(binary, args, { env, encoding: "utf8", timeout });
  events.push({ argv: [binary, ...args], exit_code: result.status, stdout_sha256: sha256(result.stdout ?? ""), stderr_sha256: sha256(result.stderr ?? "") });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const line = result.stdout.trim().split("\n").at(-1);
  return line ? JSON.parse(line) as Record<string, unknown> : {};
}

function recoveryFileId(index: number) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = index, tail = "";
  do { tail = alphabet[value % 32]! + tail; value = Math.floor(value / 32); } while (value);
  return `6${tail.padStart(25, "0")}`;
}

function inspectRecoveryFiles(filename: string) {
  const database = new Database(filename, { readonly: true }), rowsHash = createHash("sha256"), contentHash = createHash("sha256"), canonicalHash = createHash("sha256");
  let rowCount = 0, contentBytes = 0;
  try {
    for (const row of database.query(`SELECT id,workspace_id,owner_agent_id,folder,filename,mime,size,sha256,content,text_excerpt,uploaded_by_agent_id,created_at FROM files WHERE folder='p3-recovery-scale' ORDER BY id`).iterate() as IterableIterator<FileRow>) {
      const actual = sha256(row.content); assert.equal(actual, row.sha256, `${row.id} content hash`); assert.equal(row.content.byteLength, row.size, `${row.id} content size`);
      const metadata = JSON.stringify({ id: row.id, workspace_id: row.workspace_id, owner_agent_id: row.owner_agent_id, folder: row.folder, filename: row.filename, mime: row.mime, size: row.size, sha256: row.sha256, text_excerpt: row.text_excerpt, uploaded_by_agent_id: row.uploaded_by_agent_id, created_at: row.created_at });
      rowsHash.update(metadata).update("\n"); contentHash.update(row.content); canonicalHash.update(metadata).update("\0").update(row.content).update("\n");
      rowCount++; contentBytes += row.content.byteLength;
    }
    const schema = database.query("SELECT COALESCE(MAX(version),0) AS version FROM schema_versions").get() as { version: number };
    const integrity = database.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const foreignKeys = database.query("PRAGMA foreign_key_check").all();
    const indexes = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY type,name").all();
    assert.deepEqual(integrity, [{ integrity_check: "ok" }]); assert.deepEqual(foreignKeys, []);
    return { row_count: rowCount, content_bytes: contentBytes, logical_rows_sha256: rowsHash.digest("hex"), content_sha256: contentHash.digest("hex"), canonical_sha256: canonicalHash.digest("hex"), schema_version: schema.version, index_schema_sha256: sha256(JSON.stringify(indexes)), integrity_check: "ok", foreign_key_violations: 0 };
  } finally { database.close(); }
}

function recoveryScale(args: string[]) {
  const selfCheckValue = args.includes("--self-check-bytes") ? Number(option(args, "self-check-bytes")) : undefined;
  const measurementValue = args.includes("--measurement-bytes") ? Number(option(args, "measurement-bytes")) : undefined;
  if (selfCheckValue !== undefined && measurementValue !== undefined) throw new Error("REFUSED_MULTIPLE_RECOVERY_MODES");
  if (selfCheckValue !== undefined && (!Number.isSafeInteger(selfCheckValue) || selfCheckValue < 1024 ** 2 || selfCheckValue >= MAX_SELF_CHECK_BYTES)) throw new Error("REFUSED_SELF_CHECK_BYTES");
  if (measurementValue !== undefined && ![256 * 1024 ** 2, 1024 ** 3].includes(measurementValue)) throw new Error("REFUSED_MEASUREMENT_BYTES");
  if ((measurementValue !== undefined) !== args.includes("--allow-streaming-measurement")) throw new Error("REFUSED_MEASUREMENT_REQUIRES_EXPLICIT_MODE");
  const minimumBytes = selfCheckValue ?? measurementValue ?? RECOVERY_BYTES;
  const executionMode = args.includes("--execution-mode") ? option(args, "execution-mode") : undefined;
  assertRecoveryExecutionTarget(executionMode, minimumBytes, selfCheckValue === undefined ? canonicalRecoveryIdentity() : undefined);
  if (minimumBytes !== RECOVERY_BYTES && !args.includes("--allow-test-fixture")) throw new Error("REFUSED_SELF_CHECK_REQUIRES_EXPLICIT_TEST_FIXTURE_TRUST");
  const target = validateRecoveryTarget(option(args, "target"), selfCheckValue);
  const bundleInput = option(args, "bundle");
  if (!isAbsolute(bundleInput)) throw new Error("REFUSED_BUNDLE_NOT_ABSOLUTE");
  assertNoSymlinkComponents(bundleInput);
  const bundle = realpathSync(bundleInput), manifestFile = join(bundle, "manifest.json"), launcher = join(bundle, "qoopia");
  for (const file of [manifestFile, launcher]) if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("REFUSED_BUNDLE_IDENTITY_FILE");
  const manifestSha256 = sha256File(manifestFile), binarySha256 = sha256File(launcher);
  if (manifestSha256 !== option(args, "manifest-sha256")) throw new Error("REFUSED_MANIFEST_IDENTITY_MISMATCH");
  if (binarySha256 !== option(args, "binary-sha256")) throw new Error("REFUSED_BINARY_IDENTITY_MISMATCH");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as BundleManifest;
  if (manifest.format !== "qoopia-bundle/1" || !manifest.members?.qoopia || manifest.members.qoopia.sha256 !== binarySha256) throw new Error("REFUSED_BUNDLE_MANIFEST_BINDING");
  const allowFixture = args.includes("--allow-test-fixture");
  if ((manifest.signing === "test-fixture") !== allowFixture) throw new Error(manifest.signing === "test-fixture" ? "REFUSED_TEST_FIXTURE_REQUIRES_EXPLICIT_TRUST" : "REFUSED_FIXTURE_TRUST_ON_NON_FIXTURE_BUNDLE");
  const known = new Set(["--recovery-scale", "--allow-test-fixture", "--allow-streaming-measurement", "--execution-mode", "--bundle", "--manifest-sha256", "--binary-sha256", "--target", "--self-check-bytes", "--measurement-bytes", "--measurement-state"]);
  for (let index = 0; index < args.length; index++) { const arg = args[index]!; if (!known.has(arg)) throw new Error(`unknown option ${arg}`); if (!["--recovery-scale", "--allow-test-fixture", "--allow-streaming-measurement"].includes(arg)) index++; }

  const bundleBytes = Object.values(manifest.members).reduce((sum, member) => sum + member.size, 0);
  const diskRequired = minimumBytes * 6 + bundleBytes * 2 + RECOVERY_METADATA_RESERVE;
  const memoryRequired = measurementValue === undefined ? minimumBytes * 3 + 4 * 1024 ** 3 : 2 * 1024 ** 3 + 2 * RECOVERY_CHUNK_BYTES;
  const filesystem = statfsSync(dirname(target)), diskAvailable = filesystem.bavail * filesystem.bsize, memoryAvailable = totalmem();
  if (diskAvailable < diskRequired) throw new Error(`REFUSED_INSUFFICIENT_DISK: required=${diskRequired} available=${diskAvailable}`);
  if (memoryAvailable < memoryRequired) throw new Error(`REFUSED_INSUFFICIENT_MEMORY_FOR_NON_STREAMING_COMPILED_VERIFIER: required=${memoryRequired} available=${memoryAvailable}`);

  const startedAt = new Date().toISOString(), started = performance.now(), events: Array<Record<string, unknown>> = [];
  const sourceRoot = join(target, "source-installation"), backup = join(target, "backup"), restoredRoot = join(target, "restored-installation");
  mkdirSync(target, { recursive: false, mode: 0o700 });
  const stateFile = measurementValue === undefined ? undefined : resolve(option(args, "measurement-state"));
  if (stateFile && !below(stateFile, target)) throw new Error("REFUSED_MEASUREMENT_STATE_OUTSIDE_TARGET");
  const phase = (name: string) => { if (stateFile) writeFileSync(stateFile, `${JSON.stringify({ phase: name, at: new Date().toISOString() })}\n`, { mode: 0o600 }); };
  const env = { PATH: "/usr/bin:/bin", HOME: target, TMPDIR: target, XDG_CONFIG_HOME: target, XDG_CACHE_HOME: target, XDG_DATA_HOME: target };
  const flags = allowFixture ? ["--allow-test-fixture"] : [];
  try {
    phase("install");
    const installed = invoke(launcher, ["install", "--root", sourceRoot, "--bundle", bundle, "--commit", ...flags], env, 120_000, events);
    const sourceCurrent = readCurrent(sourceRoot), sourceExecutable = join(sourceRoot, "bundles", String(installed.bundle), "qoopia"), sourceDb = dataFile(sourceRoot, sourceCurrent);
    assert.equal(sha256File(sourceExecutable), binarySha256);
    const database = new Database(sourceDb);
    let insertedBytes = 0, insertedRows = 0;
    try {
      phase("materialization");
      database.exec("PRAGMA journal_mode=DELETE");
      const owner = bootstrapOwner(database, "P3 recovery-scale fixture owner", "P3 recovery-scale fixture workspace");
      const ownerAgent = owner.agent_id;
      const insert = database.query("INSERT INTO files(id,workspace_id,owner_agent_id,folder,filename,mime,size,sha256,content,text_excerpt,uploaded_by_agent_id,created_at) VALUES(?,?,?,'p3-recovery-scale',?,'application/octet-stream',?,?,?,NULL,?,?)");
      while (insertedBytes < minimumBytes) {
        const size = Math.min(RECOVERY_CHUNK_BYTES, minimumBytes - insertedBytes), content = Buffer.alloc(size, insertedRows % 251), id = recoveryFileId(insertedRows + 1);
        insert.run(id, owner.workspace_id, ownerAgent, `chunk-${String(insertedRows + 1).padStart(6, "0")}.bin`, size, sha256(content), content, ownerAgent, FIXED_TIME);
        insertedBytes += size; insertedRows++;
      }
    } finally { database.close(); }
    const sourcePhysicalBytes = statSync(sourceDb).size; assert(sourcePhysicalBytes >= minimumBytes, "source DB did not reach required physical bytes");
    const before = inspectRecoveryFiles(sourceDb), sourceDbSha256 = sha256File(sourceDb);
    assert.equal(before.content_bytes, insertedBytes); assert.equal(before.row_count, insertedRows);
    phase("backup");
    const backupResult = invoke(sourceExecutable, ["backup", "--root", sourceRoot, "--out", backup, "--commit", ...flags], env, measurementValue === undefined ? (selfCheckValue === undefined ? 14 * 60_000 : 120_000) : 180_000, events);
    const recoveryStartedAt = new Date(), recoveryStarted = performance.now();
    phase("restore");
    const restoreResult = invoke(launcher, ["restore", "--root", restoredRoot, "--new-machine", "--bundle", bundle, "--backup", backup, "--port", "0", "--commit", ...flags], env, measurementValue === undefined ? (selfCheckValue === undefined ? 14 * 60_000 : 120_000) : 180_000, events);
    const restoredCurrent = readCurrent(restoredRoot), restoredExecutable = join(restoredRoot, "bundles", restoredCurrent.bundle, "qoopia"), restoredDb = dataFile(restoredRoot, restoredCurrent);
    assert.equal(sha256File(restoredExecutable), binarySha256);
    const after = inspectRecoveryFiles(restoredDb), restoredDbSha256 = sha256File(restoredDb);
    assert.deepEqual(after, before); assert.equal(restoreResult.delivery_hold, "RECOVERY_REPLAY_REQUIRES_OWNER");
    const recoveryEndedAt = new Date(), rtoMs = Number((performance.now() - recoveryStarted).toFixed(2));
    const backupCreatedAt = new Date(String(backupResult.created_at));
    const report = {
      format: "qoopia-p3-recovery-scale-result/1", status: measurementValue !== undefined ? "PASS_BOUNDED_STREAMING_RECOVERY_MEASUREMENT" : selfCheckValue === undefined ? "RECOVERY_SCALE_EXECUTED_NOT_P3_PASS" : "PASS_SMALL_COMPILED_RECOVERY_SCALE_SELFCHECK",
      scope: measurementValue !== undefined ? `${measurementValue} byte measurement-only compiled backup/restore observation; not 5 GiB/RPO/P3 evidence` : selfCheckValue === undefined ? "5 GiB compiled backup/restore observation on caller-sanctioned disposable root; not broad P3 PASS" : "sub-32 MiB deterministic fixture through real compiled backup and restore; not 5 GiB/RPO/P3 evidence",
      started_at: startedAt, ended_at: recoveryEndedAt.toISOString(), elapsed_ms: Number((performance.now() - started).toFixed(2)),
      bundle: { path: bundle, manifest_sha256: manifestSha256, binary_sha256: binarySha256, build_sha: manifest.build_sha, source_digest: manifest.source_digest, target: manifest.target, signing: manifest.signing },
      resource_preflight: { minimum_database_bytes: minimumBytes, mode: measurementValue === undefined ? (selfCheckValue === undefined ? "5GiB" : "self-check") : "streaming-measurement", disk_formula: "6*minimum_database_bytes + 2*bundle_member_bytes + 1GiB", components: ["source DB", "backup DB", "restored DB", "one full DB WAL budget", "verifyBackup scratch DB", "one full DB restore/write reserve", "two installed bundle copies", "1GiB metadata margin"], bundle_member_bytes: bundleBytes, disk_required_bytes: diskRequired, disk_available_bytes: diskAvailable, memory_formula: measurementValue === undefined ? "3*minimum_database_bytes + 4GiB" : "2GiB safety/runtime reserve + two 4MiB streamed chunks", memory_reason: measurementValue === undefined ? "legacy fail-closed 5GiB admission threshold retained unchanged" : "measurement-only lower bound; external supervisor separately requires live available-memory headroom and stops on pressure/swap danger", memory_required_bytes: memoryRequired, physical_memory_bytes: memoryAvailable },
      materialized: { deterministic_chunk_bytes: RECOVERY_CHUNK_BYTES, rows: insertedRows, content_bytes: insertedBytes, source_database_bytes: sourcePhysicalBytes, genuine_sqlite_content_not_sparse_padding: true },
      source: { ...before, database_bytes: sourcePhysicalBytes, database_sha256: sourceDbSha256 },
      backup: { created_at: backupResult.created_at, database_bytes: backupResult.size, database_sha256: backupResult.sha256, logical_hash: backupResult.logical_hash },
      recovery: { started_at: recoveryStartedAt.toISOString(), usable_verified_at: recoveryEndedAt.toISOString(), rto_ms: rtoMs, rto_contract: "restore invocation start through restored pointer/binary identity, schema, integrity, FK, index schema, and streaming canonical row/content equality", rto_budget_ms: 15 * 60_000, rto_pass: rtoMs <= 15 * 60_000, backup_age_at_recovery_start_ms: recoveryStartedAt.getTime() - backupCreatedAt.getTime(), rpo_disposition: "manual immediate backup age observation only; NOT a scheduled <=24h RPO guarantee", restored_database_bytes: statSync(restoredDb).size, restored_database_sha256: restoredDbSha256, semantic_and_index_equality: true, delivery_hold: restoreResult.delivery_hold },
      cleanup: { root: target, owner: "caller", created_by_driver: true, self_check_removes_root: selfCheckValue !== undefined, measurement_retained_for_review: measurementValue !== undefined, real_scale_requires_caller_review_then_removal: selfCheckValue === undefined }, events,
      not_qualified: ["scheduled RPO", "final-RC trust unless the supplied bundle is that reviewed RC", "another machine/OS unless this command runs there", "broad T-14/T-27/P3 PASS"],
    };
    const reportBytes = JSON.stringify(report, null, 2) + "\n", reportSha256 = sha256(reportBytes);
    phase("final-verification"); writeFileSync(join(target, "recovery-scale-result.json"), reportBytes, { mode: 0o600 });
    assert.equal(sha256File(join(target, "recovery-scale-result.json")), reportSha256);
    if (selfCheckValue !== undefined) { rmSync(target, { recursive: true, force: true }); assert(!existsSync(target)); }
    console.log(JSON.stringify({ ...report, result_manifest_sha256: reportSha256, cleanup_completed: selfCheckValue !== undefined }, null, 2));
  } catch (error) {
    if (selfCheckValue !== undefined) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--recovery-scale")) recoveryScale(args);
  else {
    if (args.includes("--full") || args.includes("--execute-full")) throw new Error("REFUSED: full 100k/1M/5GiB workloads require separate campaign scope");
    if (args.some((arg) => arg === "--target" || arg.startsWith("--target="))) throw new Error("REFUSED: production/home/arbitrary targets are not accepted; self-check uses disposable OS temp storage only");
    if (args.length === 1 && args[0] === "--self-check") selfCheck();
    else if (args.length === 1 && args[0] === "--coverage-check") coverageCheck();
    else if (args.length === 1 && args[0] === "--plan") plan();
    else throw new Error("usage: bun run scripts/p3-qualification-materializer.ts --self-check|--coverage-check|--plan|--recovery-scale ...");
  }
}
