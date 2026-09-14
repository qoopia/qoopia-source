/**
 * agent-comm reply-routing and write integrity.
 *
 * Originally written for the ack contract (Liam, 2026-06-23). AgentComm
 * is now a plain messenger: there is no ack to send and no receipt to close, so
 * the ack cases are gone and what remains is what still has to hold —
 *  - no message is ever created owing a manual acknowledgement
 *  - a reply is REROUTED to the original requester even when the sender
 *    mis-addresses a third agent (the corsair-main bug)
 *  - send/session idempotency and reply+close atomicity
 *
 * Guard: unset wake-push webhook envs BEFORE importing agent-comm, else the
 * per-test agentSend would issue REAL HTTP POSTs to prod bridges.
 */
delete process.env.AGENTCOMM_CORSAIR_MAIN_WEBHOOK_URL;
delete process.env.AGENTCOMM_CORSAIR_MAIN_WEBHOOK_TOKEN;
delete process.env.AGENTCOMM_LEO_WEBHOOK_URL;
delete process.env.AGENTCOMM_LEO_WEBHOOK_SECRET;
delete process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN;
delete process.env.AGENTCOMM_LIAM_WEBHOOK_URL;
delete process.env.AGENTCOMM_LIAM_WEBHOOK_TOKEN;

import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import {
  agentSend,
  agentReply,
  agentInbox,
  agentSessionCreate,
} from "../src/services/agent-comm.ts";

let WS = "";
let LIAM = "";
let LEO = "";
let CORSAIR = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "ack-routing-test" });
  WS = ws.id;
  LIAM = createAgent({ name: "liam-t", workspaceSlug: ws.slug, type: "steward" }).id;
  LEO = createAgent({ name: "leo-t", workspaceSlug: ws.slug }).id;
  CORSAIR = createAgent({ name: "corsair-t", workspaceSlug: ws.slug }).id;
});

const inboxCount = (agentId: string) =>
  agentInbox({ workspace_id: WS, agent_id: agentId, limit: 100 }).items.length;
const row = (id: string): any => db.prepare("SELECT * FROM agent_comm_messages WHERE id = ?").get(id);

describe("agent-comm routing and idempotency", () => {
  test("the receipt vocabulary is gone from the schema", () => {
    // Not "the flag is 0" — the columns must not exist at all. A column named
    // acked_at or ack_required is read by its name long before anyone checks
    // what it holds.
    const cols = (db.prepare("PRAGMA table_info(agent_comm_messages)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).not.toContain("ack_required");
    expect(cols).not.toContain("acked_at");
    expect(cols).not.toContain("ack_status");
    expect(cols).toContain("delivered_at");

    // A freshly sent message starts undelivered and owes nobody anything.
    const request = agentSend({ workspace_id: WS, agent_id: LIAM, to_agent: "leo-t", body: "do X" });
    expect(row(request.id).delivered_at).toBeNull();
  });

  test("a reply is rerouted to the original requester despite a mis-addressed to_agent", () => {
    const request = agentSend({ workspace_id: WS, agent_id: LIAM, to_agent: "leo-t", body: "please review" });
    expect(inboxCount(LEO)).toBeGreaterThan(0);
    // Leo replies but mis-addresses corsair-t (the exact production bug). The
    // server must still route the answer back to the agent that asked.
    const reply = agentReply({
      workspace_id: WS, agent_id: LEO, session_id: request.session_id,
      to_agent: "corsair-t", reply_to_message_id: request.id, body: "GREEN",
    });
    const replyRow = row(reply.id);
    expect(replyRow.recipient_agent_id).toBe(LIAM);
    expect(replyRow.recipient_agent_id).not.toBe(CORSAIR);
    expect(inboxCount(CORSAIR)).toBe(0);
  });

  test("send idempotency returns the committed message and rejects key reuse drift", () => {
    const input = {
      workspace_id: WS,
      agent_id: LIAM,
      to_agent: "leo-t",
      body: "idempotent payload",
      idempotency_key: "agentcomm-test-send-1",
    };
    const first: any = agentSend(input);
    const second: any = agentSend(input);
    expect(second.id).toBe(first.id);
    expect(second.session_id).toBe(first.session_id);
    expect(second.deduplicated).toBe(true);
    const rows = db.prepare(
      "SELECT count(*) AS n FROM agent_comm_messages WHERE workspace_id = ? AND sender_agent_id = ? AND idempotency_key = ?",
    ).get(WS, LIAM, input.idempotency_key) as { n: number };
    expect(rows.n).toBe(1);
    expect(() => agentSend({ ...input, body: "different payload" })).toThrow();
  });

  test("session plus initial message commit atomically and are retry-idempotent", () => {
    const input = {
      workspace_id: WS,
      agent_id: LIAM,
      topic: "atomic initial session",
      to_agent: "leo-t",
      message: "atomic initial payload",
      idempotency_key: "agentcomm-test-session-1",
    };
    const first: any = agentSessionCreate(input);
    const second: any = agentSessionCreate(input);
    expect(first.initial_message).not.toBeNull();
    expect(second.id).toBe(first.id);
    expect(second.initial_message.id).toBe(first.initial_message.id);
    expect(second.deduplicated).toBe(true);
    const messageCount = db.prepare(
      "SELECT count(*) AS n FROM agent_comm_messages WHERE session_id = ?",
    ).get(first.id) as { n: number };
    expect(messageCount.n).toBe(1);
  });

  test("invalid initial recipient leaves no empty session behind", () => {
    const before = db.prepare(
      "SELECT count(*) AS n FROM agent_comm_sessions WHERE workspace_id = ?",
    ).get(WS) as { n: number };
    expect(() => agentSessionCreate({
      workspace_id: WS,
      agent_id: LIAM,
      topic: "must not persist",
      to_agent: "missing-agent",
      message: "cannot deliver",
    })).toThrow();
    const after = db.prepare(
      "SELECT count(*) AS n FROM agent_comm_sessions WHERE workspace_id = ?",
    ).get(WS) as { n: number };
    expect(after.n).toBe(before.n);
  });

  test("reply plus close is atomic and an idempotent retry survives the closed session", () => {
    const request = agentSend({
      workspace_id: WS,
      agent_id: LIAM,
      to_agent: "leo-t",
      body: "close after answer",
    });
    const input = {
      workspace_id: WS,
      agent_id: LEO,
      session_id: request.session_id,
      reply_to_message_id: request.id,
      body: "answered and closed",
      close: true,
      idempotency_key: "agentcomm-test-close-reply-1",
    };
    const first: any = agentReply(input);
    const second: any = agentReply(input);
    expect(second.id).toBe(first.id);
    expect(second.deduplicated).toBe(true);
    const session = db.prepare(
      "SELECT status FROM agent_comm_sessions WHERE id = ?",
    ).get(request.session_id) as { status: string };
    expect(session.status).toBe("closed");
    const rows = db.prepare(
      `SELECT count(*) AS n FROM agent_comm_messages
        WHERE sender_agent_id = ? AND idempotency_key = ?`,
    ).get(LEO, input.idempotency_key) as { n: number };
    expect(rows.n).toBe(1);
  });

  test("session idempotency rejects initial-message payload drift", () => {
    const input = {
      workspace_id: WS,
      agent_id: LIAM,
      topic: "strict session idempotency",
      to_agent: "leo-t",
      message: "original initial message",
      idempotency_key: "agentcomm-test-session-drift-1",
    };
    agentSessionCreate(input);
    expect(() => agentSessionCreate({
      ...input,
      message: "changed initial message",
    })).toThrow();
  });
});
