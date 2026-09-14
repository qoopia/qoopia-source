/** Disposable subprocess probe. Seed runs the actual schema35 source; verify runs this worktree. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthContext } from "../../src/auth/middleware.ts";
import type { SkillMetadata } from "../../src/services/skills.ts";

const [mode, root, fixtureFile] = process.argv.slice(2) as [string, string, string];
const source = (file: string) => import(pathToFileURL(`${root}/src/${file}.ts`).href);
const { db, closeDb } = await source("db/connection");
const { createMcpServer } = await source("mcp/server");
const { authenticate } = await source("auth/middleware");
const { createWorkspace } = await source("admin/workspaces");
const { createAgent, deleteAgent, setAgentType } = await source("admin/agents");
const { adminTools } = await source("mcp/admin-tools");
const { parseGrantedScope } = await source("auth/oauth");
const metadata: SkillMetadata = { skill_version: "1", owner_agent: "legacy metadata is not ownership", scope: "workspace",
  trigger_conditions: ["fixture changed"], prerequisites: ["Bun"], exact_steps: ["Read fixture"], verification_gates: ["Compare fixture"],
  failure_modes: ["Missing fixture"], rollback: "Keep previous fixture", related_code_paths: ["fixture"], related_incidents: ["fixture"] };
type Actor = { id: string; name: string; api_key: string; workspace_id: string; type: string; profile: string; allowed: boolean };
type Fixture = { workspace: { id: string; slug: string }; actors: Actor[]; manager: Actor; original: unknown; oldRows: unknown;
  oauth: { actor_id: string; stored: string | null; allowed: boolean }[] };
const authFor = (a: { api_key: string }): AuthContext => {
  const auth = authenticate(new Request("http://fixture", { headers: { authorization: `Bearer ${a.api_key}` } }));
  assert.ok(auth); return auth;
};
async function mcp(auth: AuthContext, name: string, args: Record<string, unknown>, bootstrapProfile?: string) {
  const server = createMcpServer(() => auth, "full", { agentToolProfile: auth.tool_profile, grantedScope: auth.granted_scope, bootstrapProfile });
  const client = new Client({ name: "upgrade-fixture", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const catalog = (await client.listTools()).tools.map((t) => t.name);
    try {
      const result = await client.callTool({ name, arguments: args });
      return { ok: result.isError !== true, catalog, result };
    } catch (error) { return { ok: false, catalog, result: String(error) }; }
  } finally { await client.close(); await server.close(); }
}
const legacyInput = (tag: string) => ({ slug: "shared-legacy", title: `Legacy ${tag}`, summary: "Disposable fixture", metadata });
const oldRows = () => db.query("SELECT id,workspace_id,name,type,tool_profile,active,api_key_hash,session_version FROM agents ORDER BY id").all();
try {
  if (mode === "seed") {
    const workspace = createWorkspace({ name: "Upgrade fixture", slug: "upgrade-fixture" });
    const manager = { ...createAgent({ name: "Legacy manager", workspaceSlug: workspace.slug, type: "owner" }), type: "owner", profile: "full", allowed: true };
    const actors: Actor[] = [];
    for (const type of ["standard", "claude-privileged", "steward", "owner", "ingest-daemon"]) {
      for (const profile of ["full", "no-destructive", "read-only"]) {
        // Schema35 permits only one active steward per workspace. Use the real
        // local admin APIs to prepare restricted stewards in separate workspaces.
        const separate = type === "steward" && profile !== "full";
        const ws = separate ? createWorkspace({ name: `Steward ${profile}`, slug: `steward-${profile}` }) : workspace;
        const admin = separate ? createAgent({ name: "Legacy manager", workspaceSlug: ws.slug, type: "owner" }) : manager;
        const actor = { ...createAgent({ name: `${type} ${profile}`, workspaceSlug: ws.slug, type: separate ? "standard" : type }), type, profile, allowed: profile !== "read-only" };
        await adminTools.find((t: { name: string }) => t.name === "agent_set_profile").handler({ name: actor.name, tool_profile: profile }, authFor(admin));
        if (separate) setAgentType(actor.name, ws.slug, "steward");
        // A read-only steward's workspace still contains a previously created shared skill.
        if (separate) assert.equal((await mcp(authFor(admin), "skill_upsert", legacyInput("seed"))).ok, true);
        // Both original MCP aliases are executed, with their original risk filters.
        for (const name of ["skill_upsert", "entity_upsert"]) {
          const result = await mcp(authFor(actor), name, { ...legacyInput(actor.name), ...(name === "entity_upsert" ? { type: "skill" } : {}) });
          assert.equal(result.ok, actor.allowed, `schema35 ${type}/${profile}/${name}: ${JSON.stringify(result.result)}`);
        }
        actors.push(actor);
      }
    }
    const inactive = createAgent({ name: "Inactive fixture", workspaceSlug: workspace.slug });
    deleteAgent(inactive.name, workspace.slug);
    const oauth: Fixture["oauth"] = [];
    for (const actor of actors.filter((a) => a.type === "standard")) {
      for (const stored of [null, "", "mcp:read", "mcp:write"]) {
        const allowed = actor.allowed && [null, "", "mcp:write"].includes(stored);
        const result = await mcp({ ...authFor(actor), source: "oauth", granted_scope: parseGrantedScope(stored) }, "skill_upsert", legacyInput("old oauth"));
        assert.equal(result.ok, allowed);
        oauth.push({ actor_id: actor.id, stored, allowed });
      }
    }
    const original = db.query("SELECT * FROM entity_pages WHERE workspace_id=? AND slug='shared-legacy'").get(workspace.id);
    writeFileSync(fixtureFile, JSON.stringify({ workspace, actors, manager, original, oldRows: oldRows(), oauth }), { mode: 0o600 });
    console.log(JSON.stringify({ stage: "schema35", principals: oldRows().length, alias_cases: 30, allowed: 20, denied: 10, oauth_cases: oauth.length }));
  } else if (mode === "verify") {
    const fixture: Fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
    const { workspace, actors, manager } = fixture;
    // Migration did not rewrite old roles, restrictions, keys, active flags or session versions.
    assert.deepEqual(oldRows().filter((a: { id: string }) => (fixture.oldRows as { id: string }[]).some((b) => a.id === b.id)), fixture.oldRows);
    assert.equal(db.query("SELECT count(*) n FROM workspace_owners").get().n, 0);
    assert.equal(db.query("SELECT count(*) n FROM agents WHERE principal_kind!='agent' OR authority_profile!='memory-worker'").get().n, 0);
    const original = db.query("SELECT r.* FROM skill_draft_revisions r JOIN skill_drafts d ON d.id=r.draft_id WHERE d.workspace_id=? AND revision_no=1").get(workspace.id);
    assert.deepEqual(JSON.parse(original.legacy_runbook_json), { ...(fixture.original as object), metadata: JSON.parse((fixture.original as { metadata: string }).metadata), authority_private: 0, authority_owner_id: null });
    const head = (workspaceId = workspace.id) => db.query("SELECT d.* FROM skill_drafts d JOIN entity_pages e ON e.id=d.skill_id WHERE e.workspace_id=? AND e.slug='shared-legacy'").get(workspaceId);
    const { upsertEntity } = await source("services/entities");
    const { skillUpsert, skillMarkTested } = await source("services/skills");
    const { authorize } = await source("auth/policy");
    let checks = 0;
    for (const actor of actors) {
      const auth = authFor(actor);
      assert.throws(() => authorize(db, auth, "draft"));
      assert.throws(() => authorize(db, auth, "owner"));
      assert.throws(() => authorize(db, auth, "review"));
      for (const name of ["skill_upsert", "entity_upsert"]) {
        const result = await mcp(auth, name, { ...legacyInput(actor.name), expected_revision: head(actor.workspace_id).revision,
          idempotency_key: `${actor.id}-${name}`, ...(name === "entity_upsert" ? { type: "skill" } : {}) });
        assert.equal(result.ok, actor.allowed, `schema36 ${actor.type}/${actor.profile}/${name}: ${JSON.stringify(result.result)}`);
        checks++;
      }
      // Direct legacy callers must enforce the same policy, not rely on transport filtering.
      for (const [name, invoke] of [["entity", upsertEntity], ["skill", skillUpsert]] as const) {
        const input = { ...legacyInput(actor.name), workspace_id: actor.workspace_id, type: "skill", expected_revision: head(actor.workspace_id).revision, idempotency_key: `${actor.id}-${name}-direct` };
        if (actor.allowed) assert.equal(invoke(input, auth).revision, input.expected_revision + 1);
        else assert.throws(() => invoke(input, auth), /scope or tool profile/);
        checks++;
      }
      const report = { workspace_id: actor.workspace_id, slug: "shared-legacy", tested_at: "2026-01-01T00:00:00.000Z", tester_agent: actor.id,
        expected_revision: head(actor.workspace_id).revision, idempotency_key: `${actor.id}-tested` };
      if (actor.allowed) skillMarkTested(report, auth); else assert.throws(() => skillMarkTested(report, auth));
      checks++;
    }
    const writer = actors.find((a) => a.type === "standard" && a.profile === "no-destructive")!;
    // Compare actual old OAuth decisions, including NULL/empty scope, with both current entry paths.
    for (const [i, old] of fixture.oauth.entries()) {
      const actor = actors.find((a) => a.id === old.actor_id)!;
      const oauth = { ...authFor(actor), source: "oauth" as const, granted_scope: parseGrantedScope(old.stored) };
      const input = { ...legacyInput("oauth"), expected_revision: head().revision, idempotency_key: `oauth-${i}` };
      assert.equal((await mcp(oauth, "skill_upsert", input)).ok, old.allowed);
      const direct = { ...input, expected_revision: head().revision, idempotency_key: `oauth-direct-${i}`, workspace_id: workspace.id, type: "skill" };
      if (old.allowed) upsertEntity(direct, oauth); else assert.throws(() => upsertEntity(direct, oauth));
      assert.throws(() => authorize(db, oauth, "draft"));
      // Explicit [] cannot come from schema35 parseGrantedScope. Keep P1's
      // existing fail-closed correction for such a context, never revive the old helper bug.
      assert.throws(() => upsertEntity(direct, { ...oauth, granted_scope: [] }));
    }
    const stale = authFor(writer);
    await adminTools.find((t: { name: string }) => t.name === "agent_set_profile").handler({ name: writer.name, tool_profile: "read-only" }, authFor(manager));
    const forbidden = { ...legacyInput("demoted"), workspace_id: workspace.id, type: "skill", expected_revision: head().revision, idempotency_key: "demoted" };
    assert.throws(() => upsertEntity(forbidden, stale), /generation changed/);
    assert.throws(() => upsertEntity(forbidden, authFor(writer)), /scope or tool profile/);
    assert.deepEqual(db.query("SELECT * FROM skill_draft_revisions WHERE id=?").get(original.id), original);
    assert.equal(head().actor_id, original.actor_id);
    assert.notEqual(db.query("SELECT actor_id FROM skill_draft_revisions WHERE id=?").get(head().head_revision_id).actor_id, original.actor_id);
    assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
    console.log(JSON.stringify({ stage: "schema36", legacy_cases: checks, oauth_cases: fixture.oauth.length, demotion_denials: 2, original_revision_unchanged: true }));
  } else if (mode === "owner-verify") {
    const owner = JSON.parse(readFileSync(fixtureFile, "utf8"));
    const auth = authFor(owner);
    const { issuePairing, redeemPairing } = await source("auth/pairings");
    const { reviseDraft, compileDraft, reviewSkill, registerPublisherKey, sealSkill } = await source("skills/authority");
    const { handleAuthorityRequest } = await source("api/authority");
    const { upsertEntity } = await source("services/entities");
    const { keyFromSeedHex, signManifest } = await source("skills/legacy/signing");
    const { signaturePayload } = await source("skills/format");
    const { completeContent } = await import("./p1-fixtures.ts");
    for (const route of ["owner/bootstrap", "owner/claim", "owners/bootstrap", "owners/claim"]) {
      const request = new Request(`http://fixture/api/v1/${route}`, { method: "POST", body: "{}" });
      assert.equal((await handleAuthorityRequest(request, db, auth)).status, 404);
      assert.equal((await handleAuthorityRequest(request, db, null)).status, 401);
    }
    for (const name of ["owner_bootstrap", "owner_claim", "bootstrap_owner", "claim_owner"]) {
      const remote = await mcp(auth, name, {});
      assert.equal(remote.ok, false);
      assert.equal(remote.catalog.some((n) => /bootstrap|claim/.test(n)), false);
    }
    const pair = (profile: string) => redeemPairing(issuePairing(auth, { name: `Enrolled ${profile}`, profile, runtime_id: "fixture",
      expected_revision: 1, idempotency_key: `pair-${profile}` }, db).one_time_code, db);
    const worker = pair("memory-worker"), author = pair("skill-author"), reporter = redeemPairing(issuePairing(auth, {
      name: "Enrolled reporter", profile: "runtime-reporter", target_agent_id: worker.data.agent_id, runtime_id: "fixture",
      expected_revision: 1, idempotency_key: "pair-reporter" }, db).one_time_code, db);
    const input = { ...legacyInput("new-agent"), slug: "new-agent", type: "skill", workspace_id: auth.workspace_id, expected_revision: 0, idempotency_key: "new-agent" };
    for (const denied of [worker, reporter]) {
      assert.equal(db.query("SELECT legacy_skill_access FROM agents WHERE id=?").get(denied.data.agent_id).legacy_skill_access, 0);
      assert.throws(() => upsertEntity(input, authFor(denied)));
    }
    assert.equal(upsertEntity(input, authFor(author)).revision, 1);
    const canonical = reviseDraft(auth, { slug: "owner-canonical", content: completeContent, expected_revision: 0, idempotency_key: "owner-canonical" }, db);
    const ws = db.query("SELECT slug FROM workspaces WHERE id=?").get(auth.workspace_id);
    const legacy = createAgent({ name: "Post upgrade legacy caller", workspaceSlug: ws.slug });
    const legacyAuth = authFor(legacy);
    assert.throws(() => upsertEntity({ ...input, slug: "owner-canonical", expected_revision: 1, idempotency_key: "cannot-take-canonical" }, legacyAuth), { code: "FORBIDDEN" });
    assert.throws(() => upsertEntity({ ...input, workspace_id: "other-workspace" }, legacyAuth), /authenticated principal/);
    assert.throws(() => compileDraft(legacyAuth, { draft_id: canonical.data.draft_id, expected_revision: 1, version_label: "1", license: "MIT", idempotency_key: "no-compile" }, db));
    // Seal a legacy identity through the actual owner boundary, then edit it via a different legacy caller.
    const legacyDraft = upsertEntity({ ...input, slug: "frozen-legacy", idempotency_key: "frozen-create" }, legacyAuth);
    reviseDraft(auth, { draft_id: legacyDraft.draft_id, slug: "frozen-legacy", content: completeContent, expected_revision: 1, idempotency_key: "complete-legacy" }, db);
    const compiled = compileDraft(auth, { draft_id: legacyDraft.draft_id, expected_revision: 2, version_label: "1", license: "MIT", idempotency_key: "compile-legacy" }, db);
    const reviewed = reviewSkill(auth, { version_id: compiled.data.version_id, expected_digest: compiled.data.candidate_digest, expected_revision: 0,
      kind: "content_review", decision: "approve", evidence_class: "self_reported", target_scope: "personal", capabilities: ["file_read"],
      expires_at_ms: Date.now() + 600_000, policy_epoch: 1, idempotency_key: "review-legacy" }, db);
    const key = keyFromSeedHex("01".repeat(32)); // Public deterministic test vector, never an external credential.
    registerPublisherKey(auth, { kid: "fixture-key", public_key: key.publicKeyB64url, expected_revision: 0, idempotency_key: "fixture-key" }, db);
    const descriptor = db.query("SELECT descriptor_json FROM skill_versions WHERE id=?").get(compiled.data.version_id).descriptor_json;
    sealSkill(auth, { version_id: compiled.data.version_id, expected_digest: compiled.data.candidate_digest, approval_ids: [reviewed.data.approval_id],
      publisher_key_id: "fixture-key", signature: signManifest(signaturePayload(JSON.parse(descriptor)), key.privateKey, "fixture-key").jws, idempotency_key: "seal-legacy" }, db);
    const frozen = db.query("SELECT * FROM skill_versions WHERE id=?").get(compiled.data.version_id);
    const second = createAgent({ name: "Second legacy caller", workspaceSlug: ws.slug });
    assert.equal(upsertEntity({ ...input, slug: "frozen-legacy", expected_revision: 2, idempotency_key: "edit-frozen" }, authFor(second)).revision, 3);
    assert.deepEqual(db.query("SELECT * FROM skill_versions WHERE id=?").get(compiled.data.version_id), frozen);
    const minimal = await mcp(authFor(worker), "skill_upsert", input, "memory-worker");
    const full = await mcp(authFor(worker), "skill_upsert", input);
    assert.equal(minimal.catalog.includes("skill_upsert"), false);
    assert.equal(full.catalog.includes("skill_upsert"), true);
    assert.equal(minimal.ok, false); assert.equal(full.ok, false);
    assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
    console.log(JSON.stringify({ stage: mode, remote_routes_denied: 8, remote_tools_denied: 4, new_worker_and_reporter_denied: true,
      canonical_takeover_denied: true, cross_workspace_denied: true, sealed_bytes_unchanged: true,
      catalog_default: minimal.catalog.sort(), catalog_full: full.catalog.sort() }));
  } else if (mode === "readonly") {
    const owner = JSON.parse(readFileSync(fixtureFile, "utf8"));
    const { upsertEntity } = await source("services/entities");
    const { currentToolAuth } = await source("auth/policy");
    const auth = authFor(owner);
    assert.throws(() => currentToolAuth(db, auth, "write-low"), { code: "READ_ONLY_INSTANCE" });
    const before = db.query("SELECT count(*) n FROM authority_commands").get();
    assert.throws(() => upsertEntity({ ...legacyInput("readonly"), type: "skill", workspace_id: owner.workspace_id,
      expected_revision: 0, idempotency_key: "readonly" }, auth), { code: "SQLITE_READONLY" });
    assert.deepEqual(db.query("SELECT count(*) n FROM authority_commands").get(), before);
    console.log(JSON.stringify({ stage: mode, write_denied: true }));
  } else throw new Error("Unknown disposable probe mode");
} finally { closeDb(); }
