delete process.env.AGENTCOMM_LEO_WEBHOOK_URL;
delete process.env.AGENTCOMM_LEO_WEBHOOK_SECRET;
delete process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN;

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAgent } from "../src/admin/agents.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { agentSend, agentSessionCreate } from "../src/services/agent-comm.ts";

let firstWorkspace = "";
let firstOwner = "";
let firstFleetAgent = "";
let secondFleetAgent = "";
let ownerlessSourceWorkspace = "";
let ownerlessSourceAgent = "";
let ownerlessTargetAgent = "";
let sharedOwnerSourceWorkspace = "";
let sharedOwnerTargetWorkspace = "";
let sharedOwnerSourceAgent = "";
let sharedOwnerTargetAgent = "";
let sharedOwnerSourceOriginal = "";
let sharedOwnerTargetOriginal = "";
let runSuffix = "";

beforeAll(() => {
  runMigrations();
  const suffix = randomUUID();
  runSuffix = suffix;
  const first = createWorkspace({ name: `V1 owner A ${suffix}`, slug: `v1-owner-a-${suffix}` });
  const second = createWorkspace({ name: `V1 owner B ${suffix}`, slug: `v1-owner-b-${suffix}` });
  const ownerA = bootstrapOwner(db, `V1 human A ${suffix}`, undefined, first.id);
  bootstrapOwner(db, `V1 human B ${suffix}`, undefined, second.id);
  firstWorkspace = first.id;
  firstOwner = ownerA.agent_id;
  firstFleetAgent = createAgent({ name: `v1-fleet-a-${suffix}`, workspaceSlug: first.slug }).id;
  secondFleetAgent = createAgent({ name: `v1-fleet-b-${suffix}`, workspaceSlug: second.slug }).id;

  const ownerlessSource = createWorkspace({ name: `V1 ownerless source ${suffix}`, slug: `v1-ownerless-source-${suffix}` });
  const ownerlessTarget = createWorkspace({ name: `V1 ownerless target ${suffix}`, slug: `v1-ownerless-target-${suffix}` });
  const sharedOwnerSource = createWorkspace({ name: `V1 shared owner source ${suffix}`, slug: `v1-shared-source-${suffix}` });
  const sharedOwnerTarget = createWorkspace({ name: `V1 shared owner target ${suffix}`, slug: `v1-shared-target-${suffix}` });
  ownerlessSourceWorkspace = ownerlessSource.id;
  sharedOwnerSourceWorkspace = sharedOwnerSource.id;
  sharedOwnerTargetWorkspace = sharedOwnerTarget.id;
  ownerlessSourceAgent = createAgent({ name: `v1-ownerless-source-${suffix}`, workspaceSlug: ownerlessSource.slug }).id;
  ownerlessTargetAgent = createAgent({ name: `v1-ownerless-target-${suffix}`, workspaceSlug: ownerlessTarget.slug }).id;
  sharedOwnerSourceAgent = createAgent({ name: `v1-shared-source-${suffix}`, workspaceSlug: sharedOwnerSource.slug }).id;
  sharedOwnerTargetAgent = createAgent({ name: `v1-shared-target-${suffix}`, workspaceSlug: sharedOwnerTarget.slug }).id;

  sharedOwnerSourceOriginal = bootstrapOwner(db, `V1 shared human source ${suffix}`, undefined, sharedOwnerSource.id).agent_id;
  sharedOwnerTargetOriginal = bootstrapOwner(db, `V1 shared human target ${suffix}`, undefined, sharedOwnerTarget.id).agent_id;
  // Model a legacy same-installation owner identity explicitly. Current owner
  // bootstrap creates one principal per workspace, so normalize the fixture.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id IN (?,?)")
      .run(firstOwner, sharedOwnerSource.id, sharedOwnerTarget.id);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  db.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title) VALUES (?,?, 'knowledge', ?, 'Default visibility')")
    .run(`v1-default-${suffix}`, firstWorkspace, `v1-default-${suffix}`);
  db.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title,authority_private,authority_owner_id) VALUES (?,?, 'knowledge', ?, 'Private visibility',1,?)")
    .run(`v1-private-${suffix}`, firstWorkspace, `v1-private-${suffix}`, firstOwner);
});

afterAll(() => {
  db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id=?").run(sharedOwnerSourceOriginal, sharedOwnerSourceWorkspace);
  db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id=?").run(sharedOwnerTargetOriginal, sharedOwnerTargetWorkspace);
});

describe("V1 AgentComm owner boundary", () => {
  test("same-workspace owner fleet communication remains valid", () => {
    const sent = agentSend({
      workspace_id: firstWorkspace,
      agent_id: firstOwner,
      to_agent: firstFleetAgent,
      body: "same-owner fleet message",
      kind: "status",
    });
    expect(sent.to).toContain("v1-fleet-a-");
  });

  test("distinct explicitly owned workspaces cannot address across the boundary", () => {
    const before = (db.query("SELECT count(*) AS n FROM agent_comm_messages").get() as { n: number }).n;
    expect(() => agentSend({
      workspace_id: firstWorkspace,
      agent_id: firstOwner,
      to_agent: secondFleetAgent,
      body: "must not cross independent owners",
      kind: "status",
    })).toThrow(/active agent not found/);
    expect((db.query("SELECT count(*) AS n FROM agent_comm_messages").get() as { n: number }).n).toBe(before);
  });

  test("a missing source owner refuses before AgentComm mutation", () => {
    const before = db.query("SELECT (SELECT count(*) FROM agent_comm_sessions) sessions, (SELECT count(*) FROM agent_comm_messages) messages, (SELECT count(*) FROM agent_wake_events) wakes").get();
    expect(() => agentSend({
      workspace_id: ownerlessSourceWorkspace,
      agent_id: ownerlessSourceAgent,
      to_agent: secondFleetAgent,
      body: "must not cross without source ownership",
      kind: "status",
    })).toThrow(/active agent not found/);
    expect(db.query("SELECT (SELECT count(*) FROM agent_comm_sessions) sessions, (SELECT count(*) FROM agent_comm_messages) messages, (SELECT count(*) FROM agent_wake_events) wakes").get()).toEqual(before);
  });

  test("a missing target owner refuses before AgentComm mutation", () => {
    const before = db.query("SELECT (SELECT count(*) FROM agent_comm_sessions) sessions, (SELECT count(*) FROM agent_comm_messages) messages, (SELECT count(*) FROM agent_wake_events) wakes").get();
    expect(() => agentSend({
      workspace_id: firstWorkspace,
      agent_id: firstOwner,
      to_agent: ownerlessTargetAgent,
      body: "must not cross without target ownership",
      kind: "status",
    })).toThrow(/active agent not found/);
    expect(db.query("SELECT (SELECT count(*) FROM agent_comm_sessions) sessions, (SELECT count(*) FROM agent_comm_messages) messages, (SELECT count(*) FROM agent_wake_events) wakes").get()).toEqual(before);
  });

  // F-191: answering a foreign tenant's name differently from a missing one confirms it exists.
  test("an independent tenant's agent or owner name reads exactly like a missing name", () => {
    const refusal = (to_agent: string, create: boolean) => {
      try {
        if (create) agentSessionCreate({ workspace_id: firstWorkspace, agent_id: firstOwner, topic: "probe", to_agent, message: "probe" });
        else agentSend({ workspace_id: firstWorkspace, agent_id: firstOwner, to_agent, body: "probe", kind: "status" });
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return `${e.code}: ${String(e.message).replace(to_agent, "<target>")}`;
      }
      return "sent";
    };
    for (const create of [false, true]) {
      const missing = refusal(`v1-nobody-${runSuffix}`, create);
      expect(missing).toBe("NOT_FOUND: active agent not found: <target>");
      expect(refusal(`v1-fleet-b-${runSuffix}`, create)).toBe(missing);
      expect(refusal(`V1 human B ${runSuffix}`, create)).toBe(missing);
      expect(refusal(secondFleetAgent, create)).toBe(missing);
    }
  });

  test("an independent tenant's namesake cannot make a same-owner name ambiguous", () => {
    createAgent({ name: `v1-shared-target-${runSuffix}`, workspaceSlug: `v1-owner-b-${runSuffix}` });
    const sent = agentSend({
      workspace_id: sharedOwnerSourceWorkspace,
      agent_id: sharedOwnerSourceAgent,
      to_agent: `v1-shared-target-${runSuffix}`,
      body: "same explicit owner by name",
      kind: "status",
    });
    expect(sent.to).toBe(`v1-shared-target-${runSuffix}`);
  });

  test("cross-workspace communication remains valid for the same explicit owner", () => {
    const sent = agentSend({
      workspace_id: sharedOwnerSourceWorkspace,
      agent_id: sharedOwnerSourceAgent,
      to_agent: sharedOwnerTargetAgent,
      body: "same explicit owner",
      kind: "status",
    });
    expect(sent.to).toContain("v1-shared-target-");
  });

  test("no sender can claim kind 'system'; the server never sends one", () => {
    const before = (db.query("SELECT count(*) AS n FROM agent_comm_messages").get() as { n: number }).n;
    for (const agent_id of [firstOwner, firstFleetAgent]) {
      expect(() => agentSend({
        workspace_id: firstWorkspace,
        agent_id,
        to_agent: agent_id === firstOwner ? firstFleetAgent : firstOwner,
        body: "Kind: system claims borrowed authority",
        kind: "system",
      })).toThrow(/reserved/);
    }
    expect((db.query("SELECT count(*) AS n FROM agent_comm_messages").get() as { n: number }).n).toBe(before);
  });

  test("the owner guard does not alter private or default authority flags", () => {
    const flags = db.query(
      "SELECT authority_private FROM entity_pages WHERE workspace_id=? AND slug LIKE 'v1-%' ORDER BY authority_private",
    ).all(firstWorkspace) as Array<{ authority_private: number }>;
    expect(flags.map((row) => row.authority_private)).toEqual([0, 1]);
  });
});
