import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { applyMigrationsToDatabase } from "../src/db/v4-migrations.ts";
import { configureWritableDatabase } from "../src/db/sqlite.ts";
import {
  clearExportPlanCacheForTests,
  canonicalJson,
  createExportPlan,
  materializeExportBundle,
  validateImportPlan,
} from "../src/services/export.ts";
import { createVerifiedBackup, rehearseRestore } from "../src/services/backup.ts";

const roots: string[] = [];
const MIGRATIONS = path.resolve(import.meta.dir, "..", "migrations");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-p08-export-"));
  roots.push(root);
  const filename = path.join(root, "source.db");
  const db = new Database(filename, { create: true });
  configureWritableDatabase(db);
  applyMigrationsToDatabase(db, { migrationsDir: MIGRATIONS, targetVersion: 32 });
  db.query("INSERT INTO workspaces (id,name,slug,settings) VALUES ('ws-p08','P08','p08','{}')").run();
  db.query(
    `INSERT INTO agents (id,workspace_id,name,type,api_key_hash,metadata,tool_profile)
     VALUES ('agent-owner','ws-p08','Owner','owner','hash-only','{}','full')`,
  ).run();
  db.query(
    `INSERT INTO notes (id,workspace_id,agent_id,type,text,metadata,tags)
     VALUES ('note-p08','ws-p08','agent-owner','memory','synthetic export body','{}','[]')`,
  ).run();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
  const publicPem = publicKey.export({ format: "pem", type: "spki" });
  return { root, filename, db, privatePem, publicPem };
}

afterEach(() => {
  clearExportPlanCacheForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("P08 export/import and DR", () => {
  test("complete schema-32 bundle is checksummed, signed, 0600, and plans as no-op", () => {
    const f = fixture();
    const signer = { private_key: f.privatePem };
    const plan = createExportPlan({
      workspace_id: "ws-p08", actor_id: "agent-owner", release_sha: "p08-test-sha", signer, database: f.db,
    });
    expect(plan.schema_version).toBe(32);
    expect(Object.keys(plan.policies)).toHaveLength(40);
    expect(plan.counts.notes).toBe(1);
    const bundle = materializeExportBundle({
      plan_hash: plan.plan_hash,
      idempotency_key: "p08-export-idempotency",
      workspace_id: "ws-p08",
      actor_id: "agent-owner",
      release_sha: "p08-test-sha",
      source_instance_id: "scratch-p08",
      signer,
      export_root: path.join(f.root, "exports"),
      database: f.db,
    });
    expect(fs.statSync(path.join(bundle.output_dir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(bundle.archive_path).mode & 0o777).toBe(0o600);
    const replay = materializeExportBundle({
      plan_hash: plan.plan_hash,
      idempotency_key: "p08-export-idempotency",
      workspace_id: "ws-p08",
      actor_id: "agent-owner",
      release_sha: "p08-test-sha",
      source_instance_id: "scratch-p08",
      signer,
      export_root: path.join(f.root, "exports"),
      database: f.db,
    });
    expect(replay).toEqual(bundle);
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle.output_dir, "manifest.json"), "utf8"));
    expect(manifest.tables).toHaveLength(40);
    expect(manifest.tables.find((row: any) => row.name === "oauth_tokens").path).toBeNull();
    expect(manifest.tables.find((row: any) => row.name === "notes").row_count).toBe(1);
    const result = validateImportPlan({
      bundle_dir: bundle.output_dir,
      artifact_id: bundle.artifact_id,
      target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem },
      database: f.db,
    });
    expect(result.valid).toBe(true);
    expect(result.inserts).toBe(0);
    expect(result.noops).toBeGreaterThan(0);
    expect(validateImportPlan({
      bundle_dir: bundle.output_dir,
      artifact_id: bundle.artifact_id,
      target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem },
      database: f.db,
    })).toEqual(result);
    const target = new Database(path.join(f.root, "empty-target.db"), { create: true });
    configureWritableDatabase(target);
    applyMigrationsToDatabase(target, { migrationsDir: MIGRATIONS, targetVersion: 32 });
    const freshPlan = validateImportPlan({
      bundle_dir: bundle.output_dir,
      artifact_id: bundle.artifact_id,
      target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem },
      database: target,
    });
    expect(freshPlan.valid).toBe(true);
    expect(freshPlan.inserts).toBe(3);
    target.close();
    f.db.close();
  });

  test("agent primary-key collisions require explicit identity mapping", () => {
    const f = fixture();
    const signer = { private_key: f.privatePem };
    const plan = createExportPlan({ workspace_id: "ws-p08", actor_id: "agent-owner", release_sha: "p08-identity", signer, database: f.db });
    const bundle = materializeExportBundle({
      plan_hash: plan.plan_hash, idempotency_key: "identity-identity", workspace_id: "ws-p08",
      actor_id: "agent-owner", release_sha: "p08-identity", source_instance_id: "scratch",
      signer, export_root: path.join(f.root, "exports"), database: f.db,
    });
    const target = new Database(path.join(f.root, "identity-target.db"), { create: true });
    configureWritableDatabase(target);
    applyMigrationsToDatabase(target, { migrationsDir: MIGRATIONS, targetVersion: 32 });
    target.query("INSERT INTO workspaces (id,name,slug) VALUES ('ws-other','Other','other')").run();
    target.query(
      `INSERT INTO agents (id,workspace_id,name,type,api_key_hash,metadata,tool_profile)
       VALUES ('agent-owner','ws-other','Collision','standard','hash-only','{}','read-only')`,
    ).run();
    const result = validateImportPlan({
      bundle_dir: bundle.output_dir, artifact_id: bundle.artifact_id, target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem }, database: target,
    });
    expect(result.valid).toBe(false);
    expect(result.conflicts.some((item) => item.code === "IDENTITY_MAPPING_REQUIRED")).toBe(true);
    target.close();
    f.db.close();
  });

  test("corrupt data and untrusted signatures fail closed", () => {
    const f = fixture();
    const signer = { private_key: f.privatePem };
    const plan = createExportPlan({ workspace_id: "ws-p08", actor_id: "agent-owner", release_sha: "p08-corrupt", signer, database: f.db });
    const bundle = materializeExportBundle({
      plan_hash: plan.plan_hash, idempotency_key: "corrupt-corrupt", workspace_id: "ws-p08",
      actor_id: "agent-owner", release_sha: "p08-corrupt", source_instance_id: "scratch",
      signer, export_root: path.join(f.root, "exports"), database: f.db,
    });
    expect(() => validateImportPlan({
      bundle_dir: bundle.output_dir, artifact_id: bundle.artifact_id, target_workspace_id: "ws-p08",
      trust_store: {}, database: f.db,
    })).toThrow(/not trusted/);
    const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" });
    expect(() => validateImportPlan({
      bundle_dir: bundle.output_dir, artifact_id: bundle.artifact_id, target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: wrongKey }, database: f.db,
    })).toThrow(/key ID/);
    const notes = path.join(bundle.output_dir, "data", "004-notes.ndjson");
    fs.appendFileSync(notes, "{}\n");
    expect(() => validateImportPlan({
      bundle_dir: bundle.output_dir, artifact_id: bundle.artifact_id, target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem }, database: f.db,
    })).toThrow(/checksum mismatch/);
    f.db.close();
  });

  test("import rejects symlink roots and signed manifest table-contract drift", () => {
    const f = fixture();
    const signer = { private_key: f.privatePem };
    const plan = createExportPlan({ workspace_id: "ws-p08", actor_id: "agent-owner", release_sha: "p08-contract", signer, database: f.db });
    const bundle = materializeExportBundle({
      plan_hash: plan.plan_hash, idempotency_key: "contract-contract", workspace_id: "ws-p08",
      actor_id: "agent-owner", release_sha: "p08-contract", source_instance_id: "scratch",
      signer, export_root: path.join(f.root, "exports"), database: f.db,
    });
    const link = path.join(f.root, "linked-bundle");
    fs.symlinkSync(bundle.output_dir, link, "dir");
    expect(() => validateImportPlan({
      bundle_dir: link, artifact_id: "linked-bundle", target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem }, database: f.db,
    })).toThrow(/real directory/);

    const extra = path.join(bundle.output_dir, "data", "999-duplicate.ndjson");
    fs.writeFileSync(extra, "");
    expect(() => validateImportPlan({
      bundle_dir: bundle.output_dir, artifact_id: bundle.artifact_id, target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem }, database: f.db,
    })).toThrow(/missing or extra files/);
    fs.unlinkSync(extra);

    const manifestPath = path.join(bundle.output_dir, "manifest.json");
    const signaturePath = path.join(bundle.output_dir, "manifest.sig");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    [manifest.tables[0], manifest.tables[1]] = [manifest.tables[1], manifest.tables[0]];
    const text = canonicalJson(manifest);
    const digest = createHash("sha256").update(text).digest();
    fs.writeFileSync(manifestPath, text);
    fs.writeFileSync(signaturePath, signBytes(null, digest, f.privatePem).toString("base64url"));
    expect(() => validateImportPlan({
      bundle_dir: bundle.output_dir, artifact_id: bundle.artifact_id, target_workspace_id: "ws-p08",
      trust_store: { [bundle.signature_key_id]: f.publicPem }, database: f.db,
    })).toThrow(/table contract drift/);
    f.db.close();
  });

  test("metadata secret/body keys block export instead of leaking", () => {
    const f = fixture();
    f.db.query(
      `INSERT INTO memory_event_outbox
       (id,workspace_id,event_type,aggregate_kind,aggregate_id,payload,idempotency_key)
       VALUES ('evt-secret','ws-p08','feedback_recorded','note','note-p08',?, 'secret-row-key')`,
    ).run(JSON.stringify({ token: "synthetic-not-a-real-secret" }));
    expect(() => createExportPlan({
      workspace_id: "ws-p08", actor_id: "agent-owner", release_sha: "p08-secret",
      signer: { private_key: f.privatePem }, database: f.db,
    })).toThrow(/forbidden metadata key/);
    f.db.close();
  });

  test("unknown tables or columns fail closed", () => {
    const f = fixture();
    f.db.exec("ALTER TABLE notes ADD COLUMN undeclared_export_field TEXT");
    expect(() => createExportPlan({
      workspace_id: "ws-p08", actor_id: "agent-owner", release_sha: "p08-schema-drift",
      signer: { private_key: f.privatePem }, database: f.db,
    })).toThrow(/unknown or missing columns/);
    f.db.close();
  });

  test("consistent backup and clone restore preserve logical hash within RTO", () => {
    const f = fixture();
    f.db.close();
    const backup = createVerifiedBackup({ source: f.filename, output: path.join(f.root, "backup", "snapshot.db") });
    expect(backup.integrity_check).toBe("ok");
    expect(fs.statSync(backup.output).mode & 0o777).toBe(0o600);
    const restore = rehearseRestore({ source: backup.output, workdir: path.join(f.root, "restore") });
    expect(restore.rto_pass).toBe(true);
    expect(restore.counts_match).toBe(true);
    expect(restore.source_logical_hash).toBe(restore.restored_logical_hash);
  });
});
