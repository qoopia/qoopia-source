import { expect, test } from "bun:test";
import { ownerFixture, completeContent, principalAuth } from "./helpers/p1-fixtures.ts";
import { handleAuthorityRequest, effectiveAuthority, getSkill, searchSkills, getOperation, getRunbook } from "../src/api/authority.ts";
import { reviseDraft, compileDraft } from "../src/skills/authority.ts";
import { issuePairing, redeemPairing } from "../src/auth/pairings.ts";
import { sunsetAllowed } from "../src/skills/compatibility.ts";
import { randomUUID } from "node:crypto";

test("T-05/T-22: REST closed schema, exact preconditions, current OAuth scopes and private IDs", async () => {
  // The capability catalog is a current-schema surface: it reports the agent memory policy.
  const { database: d, auth } = ownerFixture(46);
  try {
    const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://fixture/api/v1/skills/drafts", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "rest", "if-match": "0", ...headers }, body: JSON.stringify(body),
    });
    const body = { slug: "rest-skill", content: completeContent };
    expect((await handleAuthorityRequest(request({ ...body, workspace_id: auth.workspace_id }), d, auth)).status).toBe(400);
    const created = await handleAuthorityRequest(request(body), d, auth);
    expect(created.status).toBe(200);
    const originalBody = await created.clone().text();
    const result = await created.json();
    const candidate = compileDraft(auth, { draft_id: result.data.draft_id, expected_revision: 1, version_label: "1", license: "MIT", idempotency_key: "frozen-runbook" }, d);
    expect(getRunbook(auth, { version_id: candidate.data.version_id }, d).markdown).toContain("Validate a fixture");
    expect((await (await handleAuthorityRequest(request(body), d, auth)).json()).operation_id).toBe(result.operation_id);
    expect(await (await handleAuthorityRequest(request(body), d, auth)).text()).toBe(originalBody);
    expect((await handleAuthorityRequest(request({ ...body, content: { ...completeContent, title: "Changed" } }), d, auth)).status).toBe(409);
    expect((await handleAuthorityRequest(request(body), d, { ...auth, source: "oauth", granted_scope: [] })).status).toBe(403);
    const other = redeemPairing(issuePairing(auth, { name: "Other", runtime_id: "fixture", profile: "skill-author", expected_revision: 1, idempotency_key: "other" }, d).one_time_code!, d);
    const sibling = principalAuth(d, other.data.agent_id);
    expect(getSkill(sibling, { id: result.data.skill_id }, d).skill_id).toBe(result.data.skill_id); // legitimate workspace sharing
    expect(() => getOperation(sibling, { id: result.operation_id }, d)).toThrow("requester scope");
    d.query("UPDATE entity_pages SET authority_private=1,authority_owner_id=? WHERE id=?").run(auth.agent_id, result.data.skill_id);
    expect(() => getSkill(sibling, { id: result.data.skill_id }, d)).toThrow("authorized scope");
    expect(() => getRunbook(sibling, { version_id: candidate.data.version_id }, d)).toThrow("authorized scope");
    expect(searchSkills(sibling, {}, d).items).toHaveLength(0);
    const otherWorkspace = randomUUID(), foreignId = randomUUID();
    d.query("INSERT INTO workspaces(id,name,slug) VALUES (?,'Separate workspace',?)").run(otherWorkspace, otherWorkspace);
    d.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,authority_profile,tool_profile) VALUES (?,?,'Foreign','standard',?,'skill-author','full')")
      .run(foreignId, otherWorkspace, "0".repeat(64));
    const foreign = principalAuth(d, foreignId);
    expect((await handleAuthorityRequest(new Request(`http://fixture/api/v1/skills/${result.data.skill_id}`), d, foreign)).status).toBe(404);
    expect(() => getOperation(foreign, { id: result.operation_id }, d)).toThrow("requester scope");
    const capability = effectiveAuthority(sibling, d);
    expect(JSON.stringify(capability)).not.toContain('"name":"skill_seal"');
    expect(JSON.stringify(capability)).toContain('"name":"skill_draft_revise"');
    d.query("UPDATE agents SET authority_profile='memory-reader',tool_profile='read-only' WHERE id=?").run(sibling.agent_id);
    expect(() => reviseDraft(sibling, { slug: "new", content: completeContent, expected_revision: 0, idempotency_key: "new" }, d)).toThrow();
  } finally { d.close(); }
});

test("T-22: cursor is bound to principal and filters; sunset requires both time and releases plus callers", () => {
  const { database: d, auth } = ownerFixture();
  try {
    for (let i = 0; i < 3; i++) reviseDraft(auth, { slug: `skill-${i}`, content: completeContent, expected_revision: 0, idempotency_key: `create-${i}` }, d);
    const first = searchSkills(auth, { limit: 1 }, d);
    expect(first.items).toHaveLength(1); expect(first.next_cursor).not.toBeNull();
    const next = searchSkills(auth, { limit: 1, cursor: first.next_cursor }, d);
    expect(next.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(() => searchSkills(auth, { query: "different", limit: 1, cursor: first.next_cursor }, d)).toThrow("does not match");
    const base = { release_at_ms: 1, now_ms: 91 * 86400_000, subsequent_minor_releases: 2, consumers_migrated: true };
    expect(sunsetAllowed(base)).toBe(true);
    expect(sunsetAllowed({ ...base, subsequent_minor_releases: 1 })).toBe(false);
    expect(sunsetAllowed({ ...base, now_ms: 89 * 86400_000 })).toBe(false);
    expect(sunsetAllowed({ ...base, consumers_migrated: false })).toBe(false);
  } finally { d.close(); }
});
