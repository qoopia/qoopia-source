import { describe, expect, test } from "bun:test";
import { ownerFixture, principalAuth, completeContent } from "./helpers/p1-fixtures.ts";
import { issuePairing, redeemPairing, revokePrincipal } from "../src/auth/pairings.ts";
import { authorize, currentToolAuth } from "../src/auth/policy.ts";
import { parseGrantedScope } from "../src/auth/oauth.ts";
import { reviseDraft, compileDraft, reviewSkill, registerPublisherKey, sealSkill, requireExactConsent } from "../src/skills/authority.ts";
import { keyFromSeedHex, signManifest } from "../src/skills/legacy/signing.ts";
import { signaturePayload, parsePackage } from "../src/skills/format.ts";

describe("P1 authority", () => {
  test("T-05: legacy OAuth profile fallback is compatibility-only and cannot bypass current grants or revocation", () => {
    const { database: d, auth } = ownerFixture();
    try {
      for (const stored of [null, ""]) {
        const legacy = { ...auth, source: "oauth" as const, granted_scope: parseGrantedScope(stored) };
        expect(currentToolAuth(d, legacy, "write-destructive").tool_profile).toBe("full");
        expect(() => authorize(d, legacy, "read")).toThrow("OAuth scope");
        expect(() => authorize(d, legacy, "owner")).toThrow("OAuth scope");
      }
      const legacy = { ...auth, source: "oauth" as const, granted_scope: undefined };
      expect(() => currentToolAuth(d, { ...legacy, granted_scope: [] }, "read")).toThrow("Current scope");
      expect(() => currentToolAuth(d, { ...legacy, granted_scope: ["mcp:read"] }, "write-low")).toThrow("Current scope");
      d.query("UPDATE agents SET tool_profile='read-only' WHERE id=?").run(auth.agent_id);
      expect(() => currentToolAuth(d, legacy, "read")).toThrow("generation changed");
      const demoted = { ...principalAuth(d, auth.agent_id), source: "oauth" as const };
      expect(currentToolAuth(d, demoted, "read").tool_profile).toBe("read-only");
      expect(() => currentToolAuth(d, demoted, "write-destructive")).toThrow("Current scope");
      d.query("UPDATE agents SET active=0 WHERE id=?").run(auth.agent_id);
      expect(() => currentToolAuth(d, demoted, "read")).toThrow("authorized scope");
    } finally { d.close(); }
  });

  test("T-02: two agents and bound reporter; replay, expiry, revocation and scope stay separate", () => {
    const { database: d, auth } = ownerFixture();
    try {
      const first = issuePairing(auth, { name: "First", runtime_id: "fixture-runtime", profile: "skill-author", expected_revision: 1, idempotency_key: "first" }, d);
      const firstRepeat = issuePairing(auth, { name: "First", runtime_id: "fixture-runtime", profile: "skill-author", expected_revision: 1, idempotency_key: "first" }, d);
      expect(firstRepeat.one_time_code).toBeNull();
      const agent = redeemPairing(first.one_time_code!, d);
      expect(agent.data.agent_id).not.toBe(auth.agent_id);
      expect(() => redeemPairing(first.one_time_code!, d)).toThrow("already used");
      const second = issuePairing(auth, { name: "Second", runtime_id: "fixture-runtime", profile: "memory-reader", expected_revision: 1, idempotency_key: "second" }, d);
      const two = redeemPairing(second.one_time_code!, d);
      expect(two.data.agent_id).not.toBe(agent.data.agent_id);
      const reporterPair = issuePairing(auth, { name: "Reporter", runtime_id: "fixture-runtime", target_agent_id: agent.data.agent_id,
        profile: "runtime-reporter", expected_revision: 1, idempotency_key: "reporter" }, d);
      const reporter = redeemPairing(reporterPair.one_time_code!, d);
      expect(() => authorize(d, principalAuth(d, reporter.data.agent_id), "owner")).toThrow();
      expect(() => authorize(d, principalAuth(d, reporter.data.agent_id), "read")).toThrow();
      const expired = issuePairing(auth, { name: "Expired", runtime_id: "fixture-runtime", profile: "skill-author", expected_revision: 1, idempotency_key: "expired" }, d);
      d.query("UPDATE agent_pairings SET expires_at_ms=1 WHERE id=?").run(expired.data.pairing_id);
      expect(() => redeemPairing(expired.one_time_code!, d)).toThrow("expired");
      const stale = principalAuth(d, agent.data.agent_id);
      revokePrincipal(auth, { agent_id: agent.data.agent_id, expected_revision: 1, idempotency_key: "revoke" }, d);
      expect(() => authorize(d, stale, "draft")).toThrow();
      const receipts = JSON.stringify(d.query("SELECT response_json FROM authority_commands").all());
      expect(receipts).not.toContain(agent.api_key);
      expect(receipts).not.toContain(first.one_time_code!);
      expect(d.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { d.close(); }
  });

  test("T-03: immutable revisions, stale loser, 100 replays, changed body and transaction failure/retry", () => {
    const { database: d, auth } = ownerFixture();
    try {
      const input = { slug: "fixture-skill", expected_revision: 0, content: completeContent, idempotency_key: "create" };
      const first = reviseDraft(auth, input, d);
      for (let i = 0; i < 100; i++) expect(reviseDraft(auth, input, d)).toEqual(first);
      expect(d.query("SELECT count(*) AS n FROM skill_draft_revisions").get()).toEqual({ n: 1 });
      expect(() => reviseDraft(auth, { ...input, content: { ...completeContent, title: "Different" } }, d)).toThrow("different request body");
      const edit = { ...input, draft_id: first.data.draft_id, expected_revision: 1, idempotency_key: "edit", content: { ...completeContent, title: "Winner" } };
      const result = reviseDraft(auth, edit, d);
      const losing = { ...edit, idempotency_key: "loser", content: { ...completeContent, title: "Recover this edit" } };
      expect(() => reviseDraft(auth, losing, d)).toThrow("preserve submitted content");
      expect(losing.content.title).toBe("Recover this edit");
      expect(result.revision).toBe(2);
      expect(() => d.query("UPDATE skill_draft_revisions SET content_json='{}'").run()).toThrow("immutable");
      const before = d.query("SELECT count(*) AS n FROM authority_commands").get();
      d.run("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON memory_event_outbox BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
      const retry = { ...edit, expected_revision: 2, idempotency_key: "retry" };
      expect(() => reviseDraft(auth, retry, d)).toThrow("fixture disk failure");
      expect(d.query("SELECT revision FROM skill_drafts").get()).toEqual({ revision: 2 });
      expect(d.query("SELECT count(*) AS n FROM authority_commands").get()).toEqual(before);
      d.run("DROP TRIGGER fixture_outbox_failure");
      expect(reviseDraft(auth, retry, d).revision).toBe(3);
      const counts = ["authority_commands", "authority_events", "memory_event_outbox"].map((t) => d.query(`SELECT count(*) AS n FROM ${t}`).get());
      expect(counts[0]).toEqual(counts[1]); expect(counts[1]).toEqual(counts[2]);
      d.query("UPDATE agents SET policy_epoch=policy_epoch+1 WHERE id=?").run(auth.agent_id);
      expect(() => reviseDraft(auth, input, d)).toThrow("generation changed");
    } finally { d.close(); }
  });

  test("T-11/T-05: freeze, review and seal exact bytes; exact human consent rejects every changed binding", () => {
    const { database: d, auth } = ownerFixture();
    try {
      const draft = reviseDraft(auth, { slug: "exact", expected_revision: 0, content: completeContent, idempotency_key: "create" }, d);
      const c = compileDraft(auth, { draft_id: draft.data.draft_id, expected_revision: 1, version_label: "1.0.0", license: "MIT", idempotency_key: "compile" }, d);
      const review = reviewSkill(auth, { version_id: c.data.version_id, expected_digest: c.data.candidate_digest, expected_revision: 0,
        kind: "content_review", decision: "approve", evidence_class: "self_reported", target_scope: "personal", capabilities: ["file_read"],
        expires_at_ms: Date.now() + 600_000, policy_epoch: 1, idempotency_key: "review" }, d);
      const k = keyFromSeedHex("01".repeat(32));
      registerPublisherKey(auth, { kid: "fixture-publisher", public_key: k.publicKeyB64url, expected_revision: 0, idempotency_key: "key" }, d);
      const row = d.query("SELECT descriptor_json FROM skill_versions WHERE id=?").get(c.data.version_id) as { descriptor_json: string };
      const signature = signManifest(signaturePayload(JSON.parse(row.descriptor_json)), k.privateKey, "fixture-publisher").jws;
      const sealed = sealSkill(auth, { version_id: c.data.version_id, expected_digest: c.data.candidate_digest,
        approval_ids: [review.data.approval_id], publisher_key_id: "fixture-publisher", signature, idempotency_key: "seal" }, d);
      const stored = d.query("SELECT package_bytes FROM skill_versions WHERE id=?").get(c.data.version_id) as { package_bytes: Uint8Array };
      expect(parsePackage(Buffer.from(stored.package_bytes), sealed.data.package_digest, k.publicKeyB64url, "fixture-publisher").candidate_digest).toBe(c.data.candidate_digest);
      expect(() => d.query("UPDATE skill_versions SET license='changed' WHERE id=?").run(c.data.version_id)).toThrow("frozen");
      const paired = issuePairing(auth, { name: "Target", runtime_id: "runtime", profile: "skill-author", expected_revision: 1, idempotency_key: "target" }, d);
      const target = redeemPairing(paired.one_time_code!, d);
      const binding = { version_id: c.data.version_id, package_digest: sealed.data.package_digest, target_agent_id: target.data.agent_id,
        runtime_id: target.data.runtime_registration_id, target_scope: "personal", operation_id: "fixture-adopt", capabilities: ["file_read"], policy_epoch: 1 };
      const consent = reviewSkill(auth, { ...binding, expected_digest: c.data.candidate_digest, expected_revision: 0,
        kind: "high_risk_adoption", decision: "approve", evidence_class: "human_accepted", expires_at_ms: Date.now() + 600_000, idempotency_key: "consent" }, d);
      const exact = { ...binding, approval_id: consent.data.approval_id };
      expect(() => requireExactConsent(d, auth, exact)).not.toThrow();
      for (const field of ["package_digest", "runtime_id", "target_scope", "operation_id"] as const) {
        expect(() => requireExactConsent(d, auth, { ...exact, [field]: "changed" })).toThrow();
      }
      expect(() => requireExactConsent(d, auth, { ...exact, capabilities: [] })).toThrow();
      expect(() => requireExactConsent(d, auth, { ...exact, policy_epoch: 2 })).toThrow();
      d.query("UPDATE agents SET principal_kind='agent' WHERE id=?").run(auth.agent_id);
      expect(() => requireExactConsent(d, auth, exact)).toThrow();
    } finally { d.close(); }
  });
});
