import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { Database } from "bun:sqlite";
import { Delivery, dataFile, readCurrent } from "../src/delivery/operations.ts";
import { OPS_READER_CAPABILITY, OPS_READER_MEMBER } from "../src/delivery/bundle.ts";
import { durableWrite, hash, inventory, privateDirectory } from "../src/utils/fs.ts";
import { snapshotInfo, verifyBackup } from "../src/delivery/snapshot.ts";
import { createExportPlan } from "../src/services/export.ts";
import { ownerFixture } from "./helpers/p1-fixtures.ts";

const roots: string[] = [];

function bundle(root: string, name: string, trust: string, privateKey: KeyObject, schemaMin = 32, schemaMax = 37) {
  const dir = path.join(root, name);
  privateDirectory(dir);
  for (const file of [
    "qoopia", "assets/src/public/dashboard.html", "assets/src/public/brand/dashboard.js", "assets/migrations/037-skill-loop.sql", "SBOM.json",
    "THIRD-PARTY-NOTICES.txt", "assets/scripts/runtime/codex-seatbelt.py",
    `assets/native/owner-peer.${process.platform === "darwin" ? "dylib" : "so"}`,
  ]) {
    privateDirectory(path.dirname(path.join(dir, file)));
    durableWrite(path.join(dir, file), name);
  }
  durableWrite(path.join(dir, OPS_READER_MEMBER), JSON.stringify(OPS_READER_CAPABILITY));
  const raw = JSON.stringify({
    format: "qoopia-bundle/1", version: "5.0.0-p3.0", horizon: "QOOPIA-V-1", api_version: 1,
    build_sha: "a".repeat(40), source_digest: hash(name), target: `${process.platform}-${process.arch}`,
    bun_version: Bun.version, schema_min: schemaMin, schema_max: schemaMax, signing: "test-fixture",
    publisher_key_sha256: hash(trust), platform_signing: "NOT_RUN", members: inventory(dir),
  });
  durableWrite(path.join(dir, "manifest.json"), raw);
  durableWrite(path.join(dir, "manifest.sig"), sign(null, Buffer.from(raw), privateKey));
  return dir;
}

function seedHistories(database: Database, workspace: string, owner: string) {
  const origin = (database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as { instance_id: string }).instance_id;
  const bytes = Buffer.from("v1 inline file");
  const pkg = Buffer.from("v1 immutable skill package");
  database.transaction(() => {
    database.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,visibility) VALUES ('v1-note',?,?,'memory','V1 private note','private')").run(workspace, owner);
    database.query("INSERT INTO sessions(id,workspace_id,agent_id,title) VALUES ('v1-session',?,?,'V1 session')").run(workspace, owner);
    database.query("INSERT INTO session_messages(workspace_id,session_id,agent_id,role,content) VALUES (?,'v1-session',?,'user','V1 history')").run(workspace, owner);
    database.query("INSERT INTO files(id,workspace_id,owner_agent_id,filename,mime,size,sha256,content,uploaded_by_agent_id) VALUES ('v1-file',?,?, 'v1.txt','text/plain',?,?,?,?)")
      .run(workspace, owner, bytes.length, hash(bytes), bytes, owner);
    database.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title,authority_private,authority_owner_id) VALUES ('v1-skill',?,'skill','v1-skill','V1 skill',1,?)").run(workspace, owner);
    database.query("INSERT INTO skill_drafts(id,workspace_id,actor_id,origin_instance_id,created_at_ms,revision,updated_at_ms,skill_id,head_revision_id) VALUES ('v1-draft',?,?,?,?,2,?,'v1-skill','v1-rev-2')")
      .run(workspace, owner, origin, 1, 2);
    database.query("INSERT INTO skill_draft_revisions(id,workspace_id,actor_id,origin_instance_id,created_at_ms,draft_id,revision_no,parent_revision_id,source_refs,content_json,content_digest,compiler_version,missing_requirements) VALUES (?,?,?,?,?,'v1-draft',?,?,?,?,?,?,?)")
      .run("v1-rev-1", workspace, owner, origin, 1, 1, null, "[]", "{}", hash("revision-1"), "fixture", "[]");
    database.query("INSERT INTO skill_draft_revisions(id,workspace_id,actor_id,origin_instance_id,created_at_ms,draft_id,revision_no,parent_revision_id,source_refs,content_json,content_digest,compiler_version,missing_requirements) VALUES (?,?,?,?,?,'v1-draft',?,?,?,?,?,?,?)")
      .run("v1-rev-2", workspace, owner, origin, 2, 2, "v1-rev-1", "[]", "{}", hash("revision-2"), "fixture", "[]");
    database.query("INSERT INTO skill_versions(id,workspace_id,actor_id,origin_instance_id,created_at_ms,skill_id,version_label,candidate_digest,content_digest,package_digest,original_format,manifest_schema,lineage_refs,license,descriptor_json,members_json,package_bytes,status) VALUES ('v1-version',?,?,?,?, 'v1-skill','1.0.0',?,?,?,'fixture','fixture','[]','test','{}','{}',?,'sealed')")
      .run(workspace, owner, origin, 3, hash("candidate"), hash("revision-2"), hash(pkg), pkg);
  }).immediate();
}

function fixture() {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-v1-safety-")));
  roots.push(outer);
  const install = path.join(outer, "installation");
  const keys = generateKeyPairSync("ed25519");
  const trust = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const migrate = (_bundle: string, generation: string) => {
    const file = path.join(generation, "data", "qoopia.db");
    if (fs.existsSync(file)) return;
    const source = ownerFixture(37);
    seedHistories(source.database, source.owner.workspace_id, source.owner.agent_id);
    privateDirectory(path.dirname(file));
    durableWrite(file, source.database.serialize());
    source.database.close();
  };
  const delivery = new Delivery(install, trust, true, migrate);
  const first = bundle(outer, "first", trust, keys.privateKey);
  return { outer, install, trust, keys, migrate, delivery, first };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("V1 data-safety boundary", () => {
  test("legacy schema-32 workspace export refuses installed schema 37 with the complete-copy path", () => {
    const f = ownerFixture(37);
    try {
      expect(() => createExportPlan({
        workspace_id: f.owner.workspace_id,
        actor_id: f.owner.agent_id,
        release_sha: "v1-safety",
        signer: { private_key: generateKeyPairSync("ed25519").privateKey },
        database: f.database,
      })).toThrow(/legacy schema 32.*backup.*restoreNew.*complete installation/i);
    } finally {
      f.database.close();
    }
  });

  test("schema-37 backup, restoreNew, and update preserve notes, sessions, files, and skill history", () => {
    const f = fixture();
    const current = f.delivery.install(f.first, 3737);
    const backup = path.join(f.outer, "complete-backup");
    const manifest = f.delivery.backup(backup);
    expect(manifest).toMatchObject({ schema: 37, data_scope: "complete-schema-37-installation" });
    expect(verifyBackup(backup, current.instance).logical_hash).toBe(snapshotInfo(dataFile(f.install, current)).logical_hash);

    const restoredDelivery = new Delivery(path.join(f.outer, "restored"), f.trust, true, () => {});
    const restored = restoredDelivery.restoreNew(backup, f.first, 4747);
    const restoredInfo = snapshotInfo(dataFile(restoredDelivery.root, restored.current));
    expect(restoredInfo.counts).toMatchObject({ notes: 1, sessions: 1, files: 1, skill_versions: 1, skill_draft_revisions: 2 });
    const restoredDb = new Database(dataFile(restoredDelivery.root, restored.current), { readonly: true });
    expect((restoredDb.query("SELECT visibility FROM notes WHERE id='v1-note'").get() as { visibility: string }).visibility).toBe("private");
    expect(Buffer.from((restoredDb.query("SELECT content FROM files WHERE id='v1-file'").get() as { content: Uint8Array }).content).toString()).toBe("v1 inline file");
    restoredDb.close();

    const next = bundle(f.outer, "next", f.trust, f.keys.privateKey);
    const updated = f.delivery.update(next);
    expect(updated.generation).not.toBe(current.generation);
    expect(snapshotInfo(dataFile(f.install, updated)).counts).toMatchObject(restoredInfo.counts);
  });

  test("an unsupported future-schema bundle fails verification before generation publication", () => {
    const f = fixture();
    const current = f.delivery.install(f.first, 3737);
    const incompatible = bundle(f.outer, "future-only", f.trust, f.keys.privateKey, 38, 40);
    const pointer = fs.readFileSync(path.join(f.install, "current.json"));
    const source = snapshotInfo(dataFile(f.install, current));
    expect(() => f.delivery.update(incompatible)).toThrow(/schema_min|expected 32/i);
    expect(fs.readFileSync(path.join(f.install, "current.json"))).toEqual(pointer);
    expect(readCurrent(f.install).generation).toBe(current.generation);
    expect(snapshotInfo(dataFile(f.install, current))).toEqual(source);
  });

  test("migration failure preserves selected generation and all histories", () => {
    const f = fixture();
    const current = f.delivery.install(f.first, 3737);
    const next = bundle(f.outer, "failing-next", f.trust, f.keys.privateKey);
    const before = snapshotInfo(dataFile(f.install, current));
    const failed = new Delivery(f.install, f.trust, true, () => { throw new Error("injected V1 migration failure"); });
    expect(() => failed.update(next)).toThrow("injected V1 migration failure");
    expect(readCurrent(f.install).generation).toBe(current.generation);
    expect(snapshotInfo(dataFile(f.install, current))).toEqual(before);
  });
});
