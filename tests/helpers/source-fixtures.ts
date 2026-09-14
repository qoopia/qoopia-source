import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { p1Database } from "./p1-fixtures.ts";
import { splitSqlStatements } from "../../src/db/migration-033-exec.ts";
import type { SourceSnapshot } from "../../src/migrations/source-adapters.ts";
import { canonical, digest } from "../../src/skills/commands.ts";
import { readDirectory, writeTar, computeIntegrity } from "../../src/skills/legacy/archive.ts";
import { manifestHash } from "../../src/skills/legacy/signing.ts";
const workspace = "01AAAAAAAAAAAAAAAAAAAAAAAA", agent = "01BBBBBBBBBBBBBBBBBBBBBBBB", skill = "01CCCCCCCCCCCCCCCCCCCCCCCC";
export function qoopiaSource(version = 35): SourceSnapshot {
  const d = p1Database(version);
  try {
    d.query("INSERT INTO workspaces(id,name,slug) VALUES (?,'Source','source')").run(workspace);
    d.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash) VALUES (?,?,'Fixture','standard',?)").run(agent, workspace, "0".repeat(64));
    d.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title,summary,metadata) VALUES (?,?,'skill','same-skill','Qoopia original','Keep this exact body','{}')").run(skill, workspace);
    d.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,created_at,updated_at) VALUES ('note-before',?,?,'fact','Original temporal fact','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run(workspace, agent);
    d.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,created_at,updated_at) VALUES ('note-after',?,?,'fact','Current temporal fact','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')").run(workspace, agent);
    d.query("INSERT INTO note_relations(id,workspace_id,source_note_id,target_note_id,relation_type,created_at,created_by_agent_id) VALUES ('relation-fixture',?,'note-after','note-before','supersedes','2026-02-02T00:00:00.000Z',?)").run(workspace, agent);
    return { kind: "qoopia", origin: `q-${version}`, bytes: d.serialize() };
  } finally { d.close(); }
}
export function representativeQoopiaSource(version = 35): SourceSnapshot {
  const source = qoopiaSource(version), d = Database.deserialize(source.bytes);
  try {
    const t = "2026-03-01T00:00:00.000Z", admin = "01QQQQQQQQQQQQQQQQQQQQQQQQ", service = "01RRRRRRRRRRRRRRRRRRRRRRRR";
    d.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,active,last_seen,metadata,created_at,session_version,tool_profile) VALUES (?,?,?,'admin',?,1,?,'{\"fixture\":\"admin\"}',?,1,'no-destructive')")
      .run(admin, workspace, "Fixture admin", "1".repeat(64), t, t);
    d.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,active,metadata,created_at,session_version,tool_profile) VALUES (?,?,?,'service',?,0,'{\"fixture\":\"service\"}',?,2,'read-only')")
      .run(service, workspace, "Fixture service", "2".repeat(64), t);
    d.query("UPDATE entity_pages SET status='active',metadata='{\"trigger_conditions\":[\"representative\"],\"exact_steps\":[\"verify\"]}' WHERE id=?").run(skill);
    d.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,metadata,project_id,task_bound_id,session_id,source,tags,deleted_at,created_at,updated_at,visibility,updated_at_ms) VALUES ('note-context',?,?,'task','Representative nullable fields','{\"fixture\":true}','note-before','note-after','session-representative','session','[\"p3\"]',?, ?,?,'private',1)")
      .run(workspace, admin, t, t, t);
    if (version >= 35) d.query(`UPDATE notes SET valid_from=?,valid_until=?,invalidated_at=?,subject_key='fixture-subject',supersedes_id='note-before',
      created_at_ms=?,valid_from_ms=?,valid_until_ms=?,invalidated_at_ms=? WHERE id='note-context'`)
      .run(t, "2026-04-01T00:00:00.000Z", "2026-04-02T00:00:00.000Z", Date.parse(t), Date.parse(t), Date.parse("2026-04-01T00:00:00.000Z"), Date.parse("2026-04-02T00:00:00.000Z"));
    d.query("INSERT INTO sessions(id,workspace_id,agent_id,title,metadata,task_bound_id,created_at,last_active) VALUES ('session-representative',?,?,?,'{\"fixture\":true}','note-after',?,?)")
      .run(workspace, admin, "Representative session", t, t);
    d.query("INSERT INTO sessions(id,workspace_id,created_at,last_active) VALUES ('session-nullable',?,?,?)").run(workspace, t, t);
    d.query("INSERT INTO session_messages(workspace_id,session_id,agent_id,role,content,metadata,token_count,created_at,ingest_uuid) VALUES (?,?,?,'user','Representative user message','{\"fixture\":true}',4,?,'fixture-ingest')")
      .run(workspace, "session-representative", admin, t);
    d.query("INSERT INTO session_messages(workspace_id,session_id,role,content,created_at) VALUES (?,?,'assistant','Nullable agent/token/ingest variant',?)")
      .run(workspace, "session-nullable", t);
    const messages = d.query("SELECT min(id) AS a,max(id) AS b FROM session_messages").get() as { a: number; b: number };
    d.query("INSERT INTO summaries(id,workspace_id,session_id,agent_id,content,msg_start_id,msg_end_id,level,token_count,created_at) VALUES ('summary-representative',?,?,?,'Representative summary',?,?,2,3,?)")
      .run(workspace, "session-representative", admin, messages.a, messages.b, t);
    for (const [id, name, excerpt] of [["file-representative", "representative.txt", "fixture text"], ["file-nullable", "nullable.bin", null]] as const) {
      const bytes = Buffer.from(id);
      d.query("INSERT INTO files(id,workspace_id,owner_agent_id,folder,filename,mime,size,sha256,content,text_excerpt,uploaded_by_agent_id,created_at) VALUES (?,?,?,'fixtures',?,'text/plain',?,?,?,?,?,?)")
        .run(id, workspace, admin, name, bytes.length, digest(bytes), bytes, excerpt, service, t);
    }
    return { ...source, bytes: d.serialize() };
  } finally { d.close(); }
}

export function skillonomiaSource(): SourceSnapshot {
  const d = new Database(":memory:");
  try {
    for (const statement of splitSqlStatements(readFileSync(new URL("../fixtures/p1/skillonomia-19.sql", import.meta.url), "utf8"))) d.run(statement);
    d.query("INSERT INTO workspaces(id,name,created_at_ms) VALUES (?,'Source',1000)").run(workspace);
    d.query("INSERT INTO agents(id,workspace_id,name,type,created_at_ms) VALUES (?,?,'Original author','agent',1000)").run(agent, workspace);
    d.query("INSERT INTO workspace_memberships(agent_id,workspace_id,role,created_at_ms) VALUES (?,?,'owner',1000)").run(agent, workspace);
    d.query("INSERT INTO skills(id,workspace_id,slug,owner_agent_id,created_at_ms) VALUES (?,?,'same-skill',?,1000)").run(skill, workspace, agent);
    const files = readDirectory(new URL("../fixtures/p1/legacy-tv-01/package", import.meta.url).pathname);
    const manifest = JSON.parse(files.get("skill.json")!.toString()), bytes = writeTar(files);
    // TV-01's public key is public fixture data, never a live signing credential.
    d.query("INSERT INTO signing_keys(id,agent_id,kid,public_key_ed25519,created_at_ms) VALUES (?,?,?, ?,1000)")
      .run("01DDDDDDDDDDDDDDDDDDDDDDDD", agent, "tv-key-1", "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg");
    d.query(`INSERT INTO skill_versions(id,skill_id,semantic_version,author_agent_id,manifest_json,manifest_hash,content_hash,package_blob_ref,signature_jws,state,created_at_ms)
      VALUES (?,?, '1.0.0',?,?,?,?,?,?,'verified',1000)`).run("01EEEEEEEEEEEEEEEEEEEEEEEE", skill, agent,
      files.get("skill.json")!.toString(), manifestHash(manifest), digest(canonical(computeIntegrity(files))), "fixture.tar", files.get("SIGNATURE.jws")!.toString());
    const capture = "01FFFFFFFFFFFFFFFFFFFFFFFF", revision = "01GGGGGGGGGGGGGGGGGGGGGGGG", draft = "01HHHHHHHHHHHHHHHHHHHHHHHH";
    const originalContent = canonical({ title: "Native original", purpose: "Preserve approved bytes", when_to_use: "Fixture changed", procedure: ["Read fixture"], permissions: [], dependencies: [], failure_modes: [] });
    const originalDigest = `sha256:${digest(canonical({ compiler_version: "fixture-compiler/1", content: JSON.parse(originalContent) }))}`;
    d.query(`INSERT INTO captures(id,workspace_id,captured_by_agent_id,source_kind,source_format,redacted_source,source_digest,category,skillable,reason_code,outcome,server_at_ms)
      VALUES (?,?,?,'native_skill','codex_skill','Fixture source',?,'reusable_procedure',1,'fixture','drafted',1000)`).run(capture, workspace, agent, `sha256:${digest("Fixture source")}`);
    d.query(`INSERT INTO draft_revisions(id,draft_id,revision,capture_id,workspace_id,author_agent_id,origin,compiler_version,content_json,content_digest,semantic_json,security_json,server_at_ms)
      VALUES (?,?,1,?,?,?,'capture','fixture-compiler/1',?,?,'{}','{}',1000)`).run(revision, draft, capture, workspace, agent, originalContent, originalDigest);
    d.query(`INSERT INTO revision_approvals(id,draft_id,draft_revision_id,capture_id,workspace_id,revision,actor_agent_id,actor_role,source,reason_code,content_digest,provenance_json,server_at_ms)
      VALUES (?,?,?,?,?,1,?,'owner','owner','fixture',?,'{}',1000)`).run("01IIIIIIIIIIIIIIIIIIIIIIII", draft, revision, capture, workspace, agent, originalDigest);
    const event = { seq: 1, event_kind: "fixture_published", subject_id: skill, payload_hash: digest("fixture"), server_at_ms: 1000 };
    const chainHash = digest(Buffer.concat([Buffer.alloc(32), Buffer.from(digest(canonical(event)), "hex")]));
    d.query("INSERT INTO transparency_log(seq,event_kind,subject_id,payload_hash,prev_hash,this_hash,server_at_ms) VALUES (1,?,?,?, ?,?,1000)")
      .run(event.event_kind, skill, event.payload_hash, "0".repeat(64), chainHash);
    return { kind: "skillonomia", origin: "s-19", bytes: d.serialize(), blobs: new Map([["fixture.tar", bytes]]) };
  } finally { d.close(); }
}

export function representativeSkillonomiaSource(): SourceSnapshot {
  const source = skillonomiaSource(), d = Database.deserialize(source.bytes), id = (c: string) => `01${c.repeat(24)}`;
  try {
    const owner = agent, admin = id("J"), reviewer = id("K"), member = id("L"), draft = id("H"), revision = id("G"), assignment = id("M");
    for (const [agentId, name, type, profile, status, merged, passport, role] of [
      [admin, "Admin human", "human", "full", "active", null, "passport:fixture", "admin"],
      [reviewer, "Reviewer agent", "agent", "read-only", "active", null, null, "reviewer"],
      [member, "Member service", "service", null, "merged", owner, null, "member"],
    ] as const) {
      d.query("INSERT INTO agents(id,workspace_id,name,type,tool_profile,status,merged_into_agent_id,passport_ref,created_at_ms) VALUES (?,?,?,?,?,?,?,?,2000)")
        .run(agentId, workspace, name, type, profile, status, merged, passport);
      d.query("INSERT INTO workspace_memberships(agent_id,workspace_id,role,created_at_ms) VALUES (?,?,?,2000)").run(agentId, workspace, role);
    }
    d.query("UPDATE agents SET tool_profile='no-destructive' WHERE id=?").run(owner);
    d.query("INSERT INTO api_keys(id,agent_id,key_hash,created_at_ms) VALUES (?,?,?,2000)").run(id("N"), admin, "3".repeat(64));
    d.query("INSERT INTO api_keys(id,agent_id,key_hash,created_at_ms,revoked_at_ms) VALUES (?,?,?,2000,3000)").run(id("O"), reviewer, "4".repeat(64));
    d.query("UPDATE signing_keys SET revoked_at_ms=3000,secret_ref='fixture-key-ref' WHERE kid='tv-key-1'").run();
    d.query("INSERT INTO skill_access_grants(id,skill_id,grantee_agent_id,granted_by_agent_id,created_at_ms) VALUES (?,?,?,?,2000)").run(id("P"), skill, reviewer, owner);
    d.query("INSERT INTO skill_access_grants(id,skill_id,grantee_workspace_id,granted_by_agent_id,created_at_ms) VALUES (?,?,?,?,2000)").run(id("Q"), skill, workspace, admin);
    const contentDigest = (d.query("SELECT content_digest FROM draft_revisions WHERE id=?").get(revision) as { content_digest: string }).content_digest;
    d.query("INSERT INTO skill_assignments(id,workspace_id,agent_id,draft_id,created_by_agent_id,created_by_role,server_at_ms) VALUES (?,?,?,?,?,'admin',2000)")
      .run(assignment, workspace, reviewer, draft, admin);
    d.query("INSERT INTO skill_assignment_events(id,assignment_id,event_seq,event,desired_state,desired_revision_id,effective_from,actor_agent_id,actor_role,source,reason_code,reason,content_digest,provenance_json,server_at_ms) VALUES (?,?,1,'activated','active',?,'next_session',?,'admin','owner','representative','Fixture activation',?,'{\"fixture\":true}',2000)")
      .run(id("R"), assignment, revision, admin, contentDigest);
    const session = id("S"), loadout = id("T"), entry = id("U"), receipt = id("V");
    d.query("INSERT INTO agent_sessions(id,workspace_id,agent_id,runtime_kind,runtime_version,adapter_version,opened_by_agent_id,opened_by_source,server_at_ms) VALUES (?,?,?,'codex','fixture-1','adapter-1',?,'adapter',2000)")
      .run(session, workspace, reviewer, admin);
    d.query("INSERT INTO session_loadouts(id,session_id,workspace_id,agent_id,runtime_kind,runtime_version,adapter_version,entry_count,loadout_digest,provenance_json,created_at_ms,server_at_ms) VALUES (?,?,?,?,'codex','fixture-1','adapter-1',1,?,'{\"fixture\":true}',2000,2000)")
      .run(loadout, session, workspace, reviewer, `sha256:${"5".repeat(64)}`);
    d.query("INSERT INTO session_loadout_entries(id,loadout_id,position,assignment_id,draft_id,draft_revision_id,revision,skill_name,content_digest,server_at_ms) VALUES (?,?,1,?,?,?,1,'representative',?,2000)")
      .run(entry, loadout, assignment, draft, revision, contentDigest);
    d.query("INSERT INTO runtime_receipts(id,session_id,loadout_id,loadout_entry_id,assignment_id,draft_revision_id,content_digest,stage,runtime_session_ref,invocation_ref,reported_by_agent_id,source,receipt_digest,payload_json,observed_at_ms,server_at_ms) VALUES (?,?,?,?,?,?,?,'invoked','runtime-session','invocation-1',?,'runtime',?,'{\"ok\":true}',2000,2000)")
      .run(receipt, session, loadout, entry, assignment, revision, contentDigest, reviewer, `sha256:${"6".repeat(64)}`);
    d.query("INSERT INTO session_outcomes(id,session_id,loadout_id,loadout_entry_id,assignment_id,draft_id,draft_revision_id,content_digest,outcome,evidence_class,outcome_ref,reason_code,reason,source,runtime_session_ref,invocation_ref,invocation_receipt_id,reported_by_agent_id,outcome_digest,payload_json,observed_at_ms,server_at_ms) VALUES (?,?,?,?,?,?,?,?,'worked','runtime_receipt','outcome-1','representative','Fixture worked','runtime','runtime-session','invocation-1',?,?,?,'{\"worked\":true}',2000,2000)")
      .run(id("W"), session, loadout, entry, assignment, draft, revision, contentDigest, receipt, reviewer, `sha256:${"7".repeat(64)}`);
    d.query("INSERT INTO session_closures(id,session_id,workspace_id,closed_by_agent_id,source,reason_code,reason,entries_without_outcome,closed_at_ms,server_at_ms) VALUES (?,?,?,?,'adapter','representative','Fixture complete',0,3000,3000)")
      .run(id("X"), session, workspace, admin);
    assertRepresentativeSource(d);
    return { ...source, bytes: d.serialize() };
  } finally { d.close(); }
}

function assertRepresentativeSource(d: Database) {
  if (d.query("PRAGMA foreign_key_check").all().length) throw new Error("representative source fixture violates foreign keys");
  if ((d.query("SELECT count(*) AS n FROM session_loadout_entries").get() as { n: number }).n !== 1) throw new Error("representative session fixture missing");
}
