import { qoopiaSource, representativeQoopiaSource, skillonomiaSource } from "./helpers/source-fixtures.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerFixture } from "./helpers/p1-fixtures.ts";
import { preflightSource, importSource } from "../src/migrations/source-adapters.ts";
import { digest } from "../src/skills/commands.ts";

const build = "1fbfdfc0de7c01c9913eb48e7b948a9808baf2bc";
const workspace = "01AAAAAAAAAAAAAAAAAAAAAAAA", agent = "01BBBBBBBBBBBBBBBBBBBBBBBB";

test("multi-workspace history preserves isolation, message ranges and entity links when importing into an occupied installation", () => {
  const source = representativeQoopiaSource(), copy = Database.deserialize(source.bytes);
  const { database: target, auth } = ownerFixture(37), other = "other-source", otherTarget = "other-target";
  const skill = "01CCCCCCCCCCCCCCCCCCCCCCCC";
  try {
    copy.query("INSERT INTO workspaces(id,name,slug) VALUES (?,'Other','other')").run(other);
    copy.query("INSERT INTO notes(id,workspace_id,type,text) VALUES ('other-note',?,'fact','Separate workspace')").run(other);
    copy.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title) VALUES ('linked-entity',?,'skill','linked','Linked')").run(workspace);
    copy.query("INSERT INTO entity_links(source_entity_id,target_entity_id,relation_type) VALUES (?,'linked-entity','related_to')").run(skill);
    copy.query("INSERT INTO sync_applied_hashes(hash,table_name,row_id,direction) VALUES (?,'notes','note-before','C2M')").run("a".repeat(64));
    copy.run("INSERT INTO wake_slo_probes(direction,status) VALUES ('C2L','ok')");
    copy.query("INSERT INTO users(id,workspace_id,name,api_key_hash) VALUES ('legacy-user',?,'Legacy',?)").run(workspace, "b".repeat(64));
    const input = { ...source, bytes: copy.serialize() }, before = digest(input.bytes);
    target.query("INSERT INTO workspaces(id,name,slug) VALUES (?,'Other target','other-target')").run(otherTarget);
    target.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title) VALUES (?,?,'skill','occupied','Already here')").run(skill, auth.workspace_id);
    target.query("INSERT INTO sessions(id,workspace_id,title) VALUES ('session-representative',?,'Already here')").run(auth.workspace_id);
    target.query("INSERT INTO session_messages(id,workspace_id,session_id,role,content) VALUES (10,?,'session-representative','user','Existing message')").run(auth.workspace_id);
    const options = { build_sha: build, workspace_map: { [workspace]: auth.workspace_id, [other]: otherTarget } };
    expect(() => importSource(target, input, options)).toThrow("explicit archive workspace");
    expect(target.query("SELECT count(*) n FROM migration_origins").get()).toEqual({ n: 0 });
    expect(target.query("SELECT count(*) n FROM session_messages").get()).toEqual({ n: 1 });
    const approved = { ...options, archive_workspace: auth.workspace_id }, result = importSource(target, input, approved);
    expect(result.mapped_rows).toBe(preflightSource(input).canonical_rows);
    expect(target.query("SELECT workspace_id FROM notes WHERE id='other-note'").get()).toEqual({ workspace_id: otherTarget });
    const mapped = (table: string, id: string) => (target.query("SELECT local_id FROM migration_origins WHERE source_type=? AND source_id=?").get(table, id) as { local_id: string }).local_id;
    expect(target.query("SELECT source_entity_id,target_entity_id FROM entity_links").get()).toEqual({ source_entity_id: mapped("entity_pages", skill), target_entity_id: "linked-entity" });
    expect(target.query("SELECT msg_start_id,msg_end_id FROM summaries WHERE id='summary-representative'").get()).toEqual({ msg_start_id: 11, msg_end_id: 12 });
    expect(target.query("SELECT id,session_id FROM session_messages WHERE content='Representative user message'").get()).toEqual({ id: 11, session_id: mapped("sessions", "session-representative") });
    expect(target.query("SELECT session_id FROM notes WHERE id='note-context'").get()).toEqual({ session_id: mapped("sessions", "session-representative") });
    expect(target.query("SELECT count(*) n FROM sync_applied_hashes").get()).toEqual({ n: 0 });
    expect(target.query("SELECT count(*) n FROM wake_slo_probes").get()).toEqual({ n: 0 });
    expect(target.query("SELECT count(*) n FROM migration_origins WHERE disposition='global_protocol_archive' AND workspace_id=?").get(auth.workspace_id)).toEqual({ n: 2 });
    expect((target.query("SELECT api_key_hash FROM users WHERE id='legacy-user'").get() as { api_key_hash: string }).api_key_hash).not.toBe("b".repeat(64));
    expect(target.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(importSource(target, input, approved)).toEqual(result);
    expect(() => importSource(target, input, { ...approved, archive_workspace: otherTarget })).toThrow("mapping or migrator build changed");
    expect(digest(input.bytes)).toBe(before);
  } finally { copy.close(); target.close(); }
});


test("T-23: Qoopia32/35, Skillonomia19 and both; exact origins, no duplicate import, no silent collision winner", () => {
  const evidence: unknown[] = [];
  for (const sources of [[qoopiaSource(32)], [qoopiaSource()], [skillonomiaSource()], [qoopiaSource(), skillonomiaSource()]]) {
    const { database: d, auth } = ownerFixture();
    try {
      for (const source of sources) {
        const before = digest(source.bytes), plan = preflightSource(source);
        const imported = importSource(d, source, { build_sha: build, workspace_map: { [workspace]: auth.workspace_id } });
        expect(imported.mapping_coverage).toBe(1);
        expect(imported.mapped_rows).toBe(plan.canonical_rows);
        expect(importSource(d, source, { build_sha: build, workspace_map: { [workspace]: auth.workspace_id } })).toEqual(imported);
        expect(digest(source.bytes)).toBe(before);
        expect(d.query("PRAGMA foreign_key_check").all()).toEqual([]);
        evidence.push({ journey: sources.map((s) => s.origin).join("+"), source_sha256_before: before, source_sha256_after: digest(source.bytes),
          journal: imported, origin_rows: d.query("SELECT source_type,source_id,local_type,local_id,row_digest,disposition FROM migration_origins WHERE origin_instance_id=? ORDER BY source_type,source_id").all(source.origin) });
        if (source.kind === "qoopia" && plan.source_schema === 32) {
          const temporal = d.query("SELECT invalidated_at_ms,valid_until_ms,created_at_ms FROM notes WHERE id='note-before'").get() as Record<string, number>;
          expect(temporal.created_at_ms).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
          expect(temporal.invalidated_at_ms).toBe(Date.parse("2026-02-02T00:00:00.000Z"));
          expect(d.query("SELECT valid_until_inferred FROM note_temporal_provenance WHERE note_id='note-before'").get()).toEqual({ valid_until_inferred: 1 });
        }
        if (source.kind === "skillonomia") {
          expect(plan.tlog_rows).toBe(1);
          const v = d.query("SELECT package_bytes FROM skill_versions WHERE origin_instance_id=? AND original_format='skillonomia-legacy'").get(source.origin) as { package_bytes: Uint8Array };
          expect(Buffer.from(v.package_bytes).equals(source.blobs!.get("fixture.tar")!)).toBe(true);
          expect(d.query("SELECT count(*) AS n FROM agents WHERE active=1").get()).toEqual({ n: 1 });
          const native = d.query("SELECT package_bytes FROM skill_versions WHERE original_format='legacy_revision'").get() as { package_bytes: Uint8Array };
          const nativeOriginal = d.query("SELECT legacy_runbook_json FROM skill_draft_revisions WHERE original_revision_id IS NOT NULL").get() as { legacy_runbook_json: string };
          expect(Buffer.from(native.package_bytes).toString()).toBe(nativeOriginal.legacy_runbook_json);
        }
      }
      if (sources.length === 2) expect(d.query("SELECT count(*) AS n FROM entity_pages WHERE type='skill'").get()).toEqual({ n: 3 });
    } finally { d.close(); }
  }
  if (process.env.P1_EVIDENCE_DIR) writeFileSync(join(process.env.P1_EVIDENCE_DIR, "migration-fixtures.json"), JSON.stringify(evidence, null, 2) + "\n");
});

test("T-23: unknown schema/table/column and changed source refuse; rollback restores a fixture backup", () => {
  const { database: d, auth } = ownerFixture();
  const directory = mkdtempSync(join(tmpdir(), "p1-restore-"));
  try {
    const backup = d.serialize(), source = qoopiaSource();
    writeFileSync(join(directory, "backup.sqlite"), backup);
    writeFileSync(join(directory, "source.sqlite"), source.bytes);
    const copy = Database.deserialize(source.bytes);
    copy.run("CREATE TABLE unknown_data(id TEXT)");
    expect(() => preflightSource({ ...source, bytes: copy.serialize() })).toThrow("Unknown or missing");
    copy.close();
    const extraColumn = Database.deserialize(source.bytes);
    extraColumn.run("ALTER TABLE entity_pages ADD COLUMN unrecognized TEXT");
    expect(() => preflightSource({ ...source, bytes: extraColumn.serialize() })).toThrow("Unknown source columns");
    extraColumn.close();
    const old = Database.deserialize(skillonomiaSource().bytes);
    old.run("PRAGMA user_version=10");
    expect(() => preflightSource({ kind: "skillonomia", origin: "ambiguous", bytes: old.serialize() })).toThrow("schema10");
    old.close();
    const brokenChain = Database.deserialize(skillonomiaSource().bytes);
    brokenChain.query("UPDATE transparency_log SET this_hash=?").run("f".repeat(64));
    expect(() => preflightSource({ ...skillonomiaSource(), bytes: brokenChain.serialize() })).toThrow("transparency chain");
    brokenChain.close();
    d.run("CREATE TRIGGER fixture_import_failure BEFORE INSERT ON migration_origins BEGIN SELECT RAISE(ABORT,'fixture import failure'); END");
    expect(() => importSource(d, source, { build_sha: build, workspace_map: { [workspace]: auth.workspace_id } })).toThrow("fixture import failure");
    expect(d.query("SELECT count(*) AS n FROM migration_runs").get()).toEqual({ n: 0 });
    expect(d.query("SELECT count(*) AS n FROM entity_pages").get()).toEqual({ n: 0 });
    d.run("DROP TRIGGER fixture_import_failure");
    importSource(d, source, { build_sha: build, workspace_map: { [workspace]: auth.workspace_id } });
    expect(() => importSource(d, source, { build_sha: build, workspace_map: { [workspace]: "another-workspace" } })).toThrow("mapping or migrator build changed");
    expect(() => importSource(d, source, { build_sha: "a".repeat(40), workspace_map: { [workspace]: auth.workspace_id } })).toThrow("mapping or migrator build changed");
    const changed = Database.deserialize(source.bytes);
    changed.query("UPDATE entity_pages SET title='new write'").run();
    expect(() => importSource(d, { ...source, bytes: changed.serialize() }, { build_sha: build, workspace_map: { [workspace]: auth.workspace_id } })).toThrow("resume is invalidated");
    changed.close();
    const restored = new Database(join(directory, "backup.sqlite"), { readonly: true });
    expect(restored.query("SELECT count(*) AS n FROM migration_origins").get()).toEqual({ n: 0 });
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    restored.close();
    expect(digest(readFileSync(join(directory, "source.sqlite")))).toBe(digest(source.bytes));
    expect(digest(readFileSync(join(directory, "backup.sqlite")))).toBe(digest(backup));
  } finally { d.close(); rmSync(directory, { recursive: true, force: true }); }
});

// P2 consumes the same source adapter and immutable archived rows on copies.
import {loopFixture,csvContent} from './helpers/p2-fixtures.ts';
import {importPreview,resolveImport} from '../src/skills/import-review.ts';
import {captureSkill} from '../src/skills/capture.ts';
import {compileDraft} from '../src/skills/authority.ts';
import {acceptLocalSkill} from '../src/skills/loop.ts';

test('P2 migration copies: paused assignments, explicit scope resolution, unchanged source and imported lineage',()=>{
 const f=loopFixture();const source=skillonomiaSource(),copy=Database.deserialize(source.bytes);
 try{
  const draft='01HHHHHHHHHHHHHHHHHHHHHHHH';
  for(const id of ['01JJJJJJJJJJJJJJJJJJJJJJJJ','01KKKKKKKKKKKKKKKKKKKKKKKK'])copy.query("INSERT INTO skill_assignments(id,workspace_id,agent_id,draft_id,created_by_agent_id,created_by_role,server_at_ms) VALUES (?,?,?,?,?,'owner',1000)").run(id,workspace,agent,draft,agent);
  const input={...source,bytes:copy.serialize()},before=digest(input.bytes);
  const options={build_sha:build,workspace_map:{[workspace]:f.auth.workspace_id}};
  importSource(f.database,input,options);const count=(f.database.query('SELECT count(*) n FROM migration_origins').get() as {n:number}).n;
  importSource(f.database,input,options);expect((f.database.query('SELECT count(*) n FROM migration_origins').get() as {n:number}).n).toBe(count);expect(digest(input.bytes)).toBe(before);
  const preview=importPreview(f.auth,{origin:input.origin},f.database);expect(preview.items).toHaveLength(2);expect(preview.items.every(i=>i.conflict&&i.source_scope==='agent')).toBe(true);
  expect(f.database.query('SELECT count(*) n FROM skill_assignments').get()).toEqual({n:0});
  const row=f.database.query('SELECT d.id,d.skill_id,e.slug,d.revision FROM skill_drafts d JOIN entity_pages e ON e.id=d.skill_id WHERE d.origin_instance_id=?').get(input.origin) as {id:string;skill_id:string;slug:string;revision:number};
  const captured=captureSkill(f.auth,{kind:'manual',title:csvContent.title,slug:row.slug,text:'1. Read.\n2. Sum.',content:csvContent,choice:'update',draft_id:row.id,expected_revision:row.revision,idempotency_key:'import-revise'},f.database);
  const compiled=compileDraft(f.auth,{draft_id:row.id,expected_revision:captured.revision,version_label:'p2-derived',license:'MIT',native_name:'csv-import',idempotency_key:'import-compile'},f.database);
  const accept=acceptLocalSkill(f.auth,{version_id:compiled.data.version_id,expected_digest:compiled.data.candidate_digest,target_scope:'agent',expires_at_ms:Date.now()+600000,expected_revision:0,idempotency_key:'import-accept'},f.database);
  const item=preview.items[0]!,resolve={origin:input.origin,source_type:'skill_assignments',source_id:item.source_id,source_digest:item.source_digest,confirmed_source_agent_id:agent,decision:'assign',expected_revision:0,idempotency_key:'import-resolve',assignment:{runtime_id:f.runtimeId,version_id:compiled.data.version_id,package_digest:accept.data.package_digest,approval_id:accept.data.approval_id,adoption_operation_id:'import-adopt',target_scope:'agent',expires_at_ms:Date.now()+300000,expected_revision:0,idempotency_key:'import-assign'}};
  expect(()=>resolveImport(f.auth,{...resolve,assignment:{...resolve.assignment,target_scope:'project'}},f.database)).toThrow('cannot widen');
  const result=resolveImport(f.auth,resolve,f.database);expect(result.data.assignment_id).toBeTruthy();expect(resolveImport(f.auth,resolve,f.database)).toEqual(result);
  expect(f.database.query('SELECT target_scope FROM skill_assignments').get()).toEqual({target_scope:'agent'});
  expect(f.database.query('PRAGMA foreign_key_check').all()).toEqual([]);expect(digest(input.bytes)).toBe(before);
 }finally{copy.close();f.database.close();}
});
