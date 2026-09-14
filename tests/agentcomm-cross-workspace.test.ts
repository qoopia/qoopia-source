/**
 * AgentComm across workspace boundaries.
 *
 * Diana, XY and Dylon each own a workspace so that their notes and recall stay
 * theirs. That was never meant to make them unaddressable, but it did: a
 * steward token in the Default workspace got NOT_FOUND for them even by id.
 *
 * What this file pins down is the exact shape of the hole that was opened:
 * addressing and delivery cross the boundary, and nothing else does. A thread
 * still has one home workspace; a foreign agent reaches it only through its own
 * participation; memory stays where it was.
 *
 * Guard: unset wake-push webhook envs BEFORE importing agent-comm, else a send
 * here would POST at real bridges.
 */
delete process.env.AGENTCOMM_LEO_WEBHOOK_URL;
delete process.env.AGENTCOMM_LEO_WEBHOOK_SECRET;
delete process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN;

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { db } from "../src/db/connection.ts";
import { createNote, listNotes } from "../src/services/notes.ts";
import {
  agentInbox,
  agentReply,
  agentSend,
  agentSessionClose,
  agentSessionCreate,
  agentStatus,
} from "../src/services/agent-comm.ts";
import { drainAgentWakeQueue } from "../src/services/agent-wake.ts";

/** Home workspace: where the steward lives and where threads it opens are filed. */
let HOME = "";
/** Guest workspace: an agent with its own private memory. */
let GUEST = "";
let THIRD = "";

let STEWARD = "";
let HOMEMATE = "";
let GUEST_AGENT = "";
let GUEST_BYSTANDER = "";
/** Same name as an agent in GUEST — addressing it by name must not guess. */
let THIRD_TWIN = "";
let GUEST_TWIN = "";
let GUEST_OWNER = "";
let THIRD_OWNER = "";

let server: ReturnType<typeof Bun.serve> | null = null;

const WEBHOOK_ENVS = [
  "AGENTCOMM_XWS_GUEST_WEBHOOK_URL",
  "AGENTCOMM_XWS_GUEST_WEBHOOK_SECRET",
  "AGENTCOMM_XWS_GUEST_WEBHOOK_AUTH",
  "AGENTCOMM_XWS_STEWARD_WEBHOOK_URL",
  "AGENTCOMM_XWS_STEWARD_WEBHOOK_SECRET",
  "AGENTCOMM_XWS_STEWARD_WEBHOOK_AUTH",
];

beforeAll(() => {
  runMigrations();
  const home = createWorkspace({ name: "xws Home", slug: "xws-home" });
  const guest = createWorkspace({ name: "xws Guest", slug: "xws-guest" });
  const third = createWorkspace({ name: "xws Third", slug: "xws-third" });
  HOME = home.id;
  GUEST = guest.id;
  THIRD = third.id;

  STEWARD = createAgent({ name: "xws-steward", workspaceSlug: home.slug, type: "steward" }).id;
  HOMEMATE = createAgent({ name: "xws-homemate", workspaceSlug: home.slug }).id;
  GUEST_AGENT = createAgent({ name: "xws-guest", workspaceSlug: guest.slug }).id;
  GUEST_BYSTANDER = createAgent({ name: "xws-bystander", workspaceSlug: guest.slug }).id;
  GUEST_TWIN = createAgent({ name: "xws-twin", workspaceSlug: guest.slug }).id;
  THIRD_TWIN = createAgent({ name: "xws-twin", workspaceSlug: third.slug }).id;

  const owner = bootstrapOwner(db, "xws shared owner", undefined, HOME);
  GUEST_OWNER = bootstrapOwner(db, "xws guest owner fixture", undefined, GUEST).agent_id;
  THIRD_OWNER = bootstrapOwner(db, "xws third owner fixture", undefined, THIRD).agent_id;
  // These legacy cross-workspace cases intentionally model one explicit owner.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id IN (?,?,?)")
      .run(owner.agent_id, HOME, GUEST, THIRD);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
});

beforeEach(() => {
  server?.stop();
  server = null;
  for (const key of WEBHOOK_ENVS) delete process.env[key];
  // Undelivered leftovers ride along with the next wake; drop them so each test
  // observes only its own payload.
  db.prepare(`DELETE FROM agent_wake_events WHERE delivered_at IS NULL`).run();
});

afterAll(() => {
  server?.stop();
  for (const key of WEBHOOK_ENVS) delete process.env[key];
  db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id=?").run(GUEST_OWNER, GUEST);
  db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id=?").run(THIRD_OWNER, THIRD);
});

/** What a recipient runtime returns once it has accepted the messages. */
function accepted(): Response {
  return Response.json({ accepted: true, hook_id: "test" }, { status: 202 });
}

function serveGuest(handler: (payload: any) => Response): void {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => handler(await request.json()),
  });
  process.env.AGENTCOMM_XWS_GUEST_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
  process.env.AGENTCOMM_XWS_GUEST_WEBHOOK_SECRET = "test-only-xws-secret";
  process.env.AGENTCOMM_XWS_GUEST_WEBHOOK_AUTH = "hmac";
}

const messageRow = (id: string): any =>
  db.prepare(`SELECT * FROM agent_comm_messages WHERE id = ?`).get(id);
const wakeRowFor = (messageId: string): any =>
  db.prepare(`SELECT * FROM agent_wake_events WHERE message_id = ?`).get(messageId);
const sessionRow = (id: string): any =>
  db.prepare(`SELECT * FROM agent_comm_sessions WHERE id = ?`).get(id);

describe("addressing crosses the workspace boundary", () => {
  test("a send to an agent in another workspace resolves by name and by id", () => {
    const byName = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "by name",
      kind: "system",
    });
    expect(byName.to).toBe("xws-guest");
    expect(messageRow(byName.id).recipient_agent_id).toBe(GUEST_AGENT);

    const byId = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: GUEST_AGENT,
      body: "by id",
      kind: "system",
    });
    expect(messageRow(byId.id).recipient_agent_id).toBe(GUEST_AGENT);
  });

  test("the thread stays homed in the sender's workspace", () => {
    // The guest's workspace gains no session, no message and no wake. All it
    // gains is a message addressed to it.
    const sent = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "homing check",
      kind: "system",
    });
    expect(messageRow(sent.id).workspace_id).toBe(HOME);
    expect(sessionRow(sent.session_id).workspace_id).toBe(HOME);
    expect(wakeRowFor(sent.id).workspace_id).toBe(HOME);
  });

  test("an own-workspace name always wins over a foreign one", () => {
    // xws-twin exists in GUEST and in THIRD. From THIRD the local one answers,
    // so introducing a namesake elsewhere can never re-point a local thread.
    const sent = agentSend({
      workspace_id: THIRD,
      agent_id: THIRD_TWIN,
      to_agent: "xws-twin",
      body: "self-addressed, but local",
      kind: "system",
    });
    expect(messageRow(sent.id).recipient_agent_id).toBe(THIRD_TWIN);
  });

  test("a name that is ambiguous across workspaces is a CONFLICT, not a guess", () => {
    expect(() =>
      agentSend({
        workspace_id: HOME,
        agent_id: STEWARD,
        to_agent: "xws-twin",
        body: "which one?",
        kind: "system",
      }),
    ).toThrow(/ambiguous across workspaces/);

    // Addressing by id disambiguates it.
    const sent = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: GUEST_TWIN,
      body: "that one",
      kind: "system",
    });
    expect(messageRow(sent.id).recipient_agent_id).toBe(GUEST_TWIN);
  });

  test("a name that exists nowhere is still NOT_FOUND", () => {
    expect(() =>
      agentSend({
        workspace_id: HOME,
        agent_id: STEWARD,
        to_agent: "nobody-at-all",
        body: "hello?",
        kind: "system",
      }),
    ).toThrow(/active agent not found/);
  });

  test("an inactive agent in another workspace is not reachable", () => {
    const parked = createAgent({ name: "xws-parked", workspaceSlug: "xws-guest" }).id;
    db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(parked);
    expect(() =>
      agentSend({
        workspace_id: HOME,
        agent_id: STEWARD,
        to_agent: "xws-parked",
        body: "still there?",
        kind: "system",
      }),
    ).toThrow(/active agent not found/);
  });

  test("agent_status answers a single-name lookup across the boundary, flagged", () => {
    const found = agentStatus({ workspace_id: HOME, agent: "xws-guest" });
    expect(found.agents).toHaveLength(1);
    expect(found.agents[0]).toMatchObject({ name: "xws-guest", external_workspace: true });

    // The unfiltered listing stays workspace-local — this is a lookup, not a
    // directory of the whole instance.
    const listed = agentStatus({ workspace_id: HOME, limit: 100 });
    expect(listed.agents.map((a) => a.name)).not.toContain("xws-guest");
  });
});

describe("delivery crosses the workspace boundary", () => {
  test("a cross-workspace wake is delivered and stamps the message", async () => {
    let payload: any = null;
    serveGuest((body) => {
      payload = body;
      return accepted();
    });

    const sent = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "cross-workspace delivery",
      kind: "system",
    });
    const result = await drainAgentWakeQueue({ eventId: sent.wake!.event_id });

    expect(result[0]?.status).toBe("delivered");
    expect(payload.to_agent).toBe("xws-guest");
    expect(payload.messages.some((m: any) => m.body === "cross-workspace delivery")).toBe(true);
    expect(wakeRowFor(sent.id).status).toBe("delivered");
    expect(messageRow(sent.id).delivered_at).not.toBeNull();
  });

  test("acceptance is still required — a bare 2xx is not a delivery", async () => {
    // The boundary change must not have bought delivery by weakening the proof
    // of it. A cross-workspace hop is held to exactly the same acknowledgement.
    serveGuest(() => Response.json({ ok: true }, { status: 200 }));

    const sent = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "unconfirmed hop",
      kind: "system",
    });
    const result = await drainAgentWakeQueue({ eventId: sent.wake!.event_id });

    expect(result[0]).toMatchObject({
      status: "failed",
      error: "runtime_did_not_confirm_acceptance",
    });
    expect(messageRow(sent.id).delivered_at).toBeNull();
  });

  test("a wake pointed at an agent the message was not addressed to is ignored", async () => {
    // Structural integrity of the thread is still enforced; only the
    // participants' workspaces are allowed to differ.
    serveGuest(() => accepted());
    const sent = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "repointed wake",
      kind: "system",
    });
    db.prepare(`UPDATE agent_wake_events SET target_agent_id = ? WHERE message_id = ?`)
      .run(GUEST_BYSTANDER, sent.id);

    const result = await drainAgentWakeQueue({ eventId: sent.wake!.event_id });
    expect(result[0]).toMatchObject({
      status: "ignored",
      attempted: false,
      error: "inactive_or_workspace_mismatch",
    });
  });

  test("a thread whose message and session disagree on their home is ignored", async () => {
    serveGuest(() => accepted());
    const sent = agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "forged home",
      kind: "system",
    });
    db.prepare(`UPDATE agent_comm_messages SET workspace_id = ? WHERE id = ?`)
      .run(GUEST, sent.id);

    const result = await drainAgentWakeQueue({ eventId: sent.wake!.event_id });
    expect(result[0]).toMatchObject({
      status: "ignored",
      error: "inactive_or_workspace_mismatch",
    });
  });
});

describe("a foreign participant can hold up its end of the thread", () => {
  test("the recipient sees the message in its inbox and can reply into it", () => {
    const sent = agentSessionCreate({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      topic: "cross-workspace thread",
      message: "are you there?",
    });
    const sessionId = sent.id;

    const inbox = agentInbox({ workspace_id: GUEST, agent_id: GUEST_AGENT, limit: 100 });
    expect(inbox.items.some((m) => m.body === "are you there?")).toBe(true);

    const reply = agentReply({
      workspace_id: GUEST,
      agent_id: GUEST_AGENT,
      session_id: sessionId,
      body: "here",
    });
    // The reply is filed with the thread it answers, not with its author.
    expect(messageRow(reply.id).workspace_id).toBe(HOME);
    expect(messageRow(reply.id).recipient_agent_id).toBe(STEWARD);
    expect(wakeRowFor(reply.id).workspace_id).toBe(HOME);

    const back = agentInbox({ workspace_id: HOME, agent_id: STEWARD, limit: 100 });
    expect(back.items.some((m) => m.body === "here")).toBe(true);
  });

  test("the recipient can close a thread it participates in", () => {
    const opened = agentSessionCreate({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      topic: "closable thread",
      message: "done soon",
    });
    const closed = agentSessionClose({
      workspace_id: GUEST,
      agent_id: GUEST_AGENT,
      session_id: opened.id,
      reason: "handled",
    });
    expect(closed.status).toBe("closed");
    expect(sessionRow(opened.id).status).toBe("closed");
  });

  test("a bystander in the recipient's workspace cannot touch the thread", () => {
    const opened = agentSessionCreate({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      topic: "private to its participants",
      message: "not for you",
    });
    // Participation, not workspace membership, is the key — and the bystander
    // has none, even though its own colleague is in the thread.
    expect(() =>
      agentReply({
        workspace_id: GUEST,
        agent_id: GUEST_BYSTANDER,
        session_id: opened.id,
        body: "listening in",
      }),
    ).toThrow(/agent session not found/);
    expect(() =>
      agentSessionClose({
        workspace_id: GUEST,
        agent_id: GUEST_BYSTANDER,
        session_id: opened.id,
      }),
    ).toThrow(/agent session not found/);
    expect(() =>
      agentSend({
        workspace_id: GUEST,
        agent_id: GUEST_BYSTANDER,
        to_agent: "xws-steward",
        session_id: opened.id,
        body: "butting in",
        kind: "system",
      }),
    ).toThrow(/agent session not found/);
  });

  test("an inbox returns what was addressed to the agent and nothing else", () => {
    agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: HOMEMATE,
      body: "home-only traffic",
      kind: "system",
    });
    const guestInbox = agentInbox({ workspace_id: GUEST, agent_id: GUEST_AGENT, limit: 100 });
    expect(guestInbox.items.every((m) => m.to === "xws-guest")).toBe(true);
    expect(guestInbox.items.some((m) => m.body === "home-only traffic")).toBe(false);
  });
});

describe("memory does not cross the boundary", () => {
  test("notes stay private to their workspace after a thread is opened across it", () => {
    createNote({
      workspace_id: HOME,
      agent_id: STEWARD,
      text: "xws home-only note content",
      type: "fact",
    });
    createNote({
      workspace_id: GUEST,
      agent_id: GUEST_AGENT,
      text: "xws guest-only note content",
      type: "fact",
    });

    agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "opening a thread does not open the memory",
      kind: "system",
    });

    const guestText = listNotes({
      workspace_id: GUEST,
      caller_agent_id: GUEST_AGENT,
      is_admin: false,
      limit: 500,
    }).items.map((n: any) => n.text);
    expect(guestText).toContain("xws guest-only note content");
    expect(guestText).not.toContain("xws home-only note content");

    const homeText = listNotes({
      workspace_id: HOME,
      caller_agent_id: STEWARD,
      is_admin: true,
      limit: 500,
    }).items.map((n: any) => n.text);
    expect(homeText).toContain("xws home-only note content");
    expect(homeText).not.toContain("xws guest-only note content");
  });

  test("the guest workspace holds no session, message or wake from the home thread", () => {
    const count = (table: string, workspace: string) =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace_id = ?`)
        .get(workspace) as { c: number }).c;
    const before = {
      sessions: count("agent_comm_sessions", GUEST),
      messages: count("agent_comm_messages", GUEST),
      wakes: count("agent_wake_events", GUEST),
    };
    agentSend({
      workspace_id: HOME,
      agent_id: STEWARD,
      to_agent: "xws-guest",
      body: "nothing is filed on your side",
      kind: "system",
    });
    expect(count("agent_comm_sessions", GUEST)).toBe(before.sessions);
    expect(count("agent_comm_messages", GUEST)).toBe(before.messages);
    expect(count("agent_wake_events", GUEST)).toBe(before.wakes);
  });
});
