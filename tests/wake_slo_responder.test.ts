/**
 * Unit tests for the wake SLO responder.
 * Contract: /srv/qoopia/docs/wake-slo-responder-contract.md
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ulid } from "ulid";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import { maybeRespondToProbe } from "../src/services/wake_slo_responder.ts";

let WORKSPACE_ID = "";
let SENDER_ID = "";
let RECIPIENT_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Wake SLO responder", slug: "wake-slo-resp" });
  WORKSPACE_ID = ws.id;
  const sender = createAgent({ name: "wake-slo-sender", workspaceSlug: ws.slug });
  const recipient = createAgent({ name: "wake-slo-recipient", workspaceSlug: ws.slug });
  SENDER_ID = sender.id;
  RECIPIENT_ID = recipient.id;
});

function mintProbeSession(topic: string): string {
  const id = ulid();
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_comm_sessions
       (id, workspace_id, topic, status, created_by_agent_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, '{}', ?, ?)`,
  ).run(id, WORKSPACE_ID, topic, SENDER_ID, ts, ts);
  return id;
}

function mintProbeMessage(session_id: string, body: string): string {
  const id = ulid();
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_comm_messages
       (id, workspace_id, session_id, sender_agent_id, recipient_agent_id,
        kind, body, metadata, parent_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'request', ?, '{}', NULL, ?)`,
  ).run(id, WORKSPACE_ID, session_id, SENDER_ID, RECIPIENT_ID, body, ts);
  return id;
}

describe("maybeRespondToProbe", () => {
  test("matching probe ⇒ pong reply written within 100ms", () => {
    const iso = "2026-05-24T00:30:00.000Z";
    const topic = "WAKE_SLO_PROBE_C2L_1779582600000";
    const session_id = mintProbeSession(topic);
    const message_id = mintProbeMessage(session_id, `WAKE_SLO_PING ${iso}`);

    const t0 = performance.now();
    const r = maybeRespondToProbe({
      workspace_id: WORKSPACE_ID,
      message_id,
      session_id,
      topic,
      body: `WAKE_SLO_PING ${iso}`,
      sender_agent_id: SENDER_ID,
      recipient_agent_id: RECIPIENT_ID,
    });
    const dt = performance.now() - t0;

    expect(r.matched).toBe(true);
    expect((r as { replied: boolean }).replied).toBe(true);
    expect(dt).toBeLessThan(100);

    const reply = db
      .prepare(
        `SELECT body FROM agent_comm_messages
          WHERE session_id = ? AND kind = 'reply' LIMIT 1`,
      )
      .get(session_id) as { body: string } | undefined;
    expect(reply?.body).toBe(`WAKE_SLO_PONG ${iso}`);

    const acked = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_comm_messages WHERE parent_message_id = ? AND kind = 'ack'`)
      .get(message_id) as { n: number };
    // The probe is answered with a pong reply. There is no ack row any more.
    expect(acked.n).toBe(0);
  });

  test("non-matching topic ⇒ no reply", () => {
    const iso = "2026-05-24T00:30:01.000Z";
    const session_id = mintProbeSession("SMOKE_unrelated");
    const message_id = mintProbeMessage(session_id, `WAKE_SLO_PING ${iso}`);

    const r = maybeRespondToProbe({
      workspace_id: WORKSPACE_ID,
      message_id,
      session_id,
      topic: "SMOKE_unrelated",
      body: `WAKE_SLO_PING ${iso}`,
      sender_agent_id: SENDER_ID,
      recipient_agent_id: RECIPIENT_ID,
    });
    expect(r.matched).toBe(false);

    const reply = db
      .prepare(`SELECT count(*) AS n FROM agent_comm_messages WHERE session_id = ? AND kind = 'reply'`)
      .get(session_id) as { n: number };
    expect(reply.n).toBe(0);
  });

  test("non-matching body ⇒ no reply", () => {
    const topic = "WAKE_SLO_PROBE_L2C_1779582601000";
    const session_id = mintProbeSession(topic);
    const message_id = mintProbeMessage(session_id, "HELLO");

    const r = maybeRespondToProbe({
      workspace_id: WORKSPACE_ID,
      message_id,
      session_id,
      topic,
      body: "HELLO",
      sender_agent_id: SENDER_ID,
      recipient_agent_id: RECIPIENT_ID,
    });
    expect(r.matched).toBe(false);

    const reply = db
      .prepare(`SELECT count(*) AS n FROM agent_comm_messages WHERE session_id = ? AND kind = 'reply'`)
      .get(session_id) as { n: number };
    expect(reply.n).toBe(0);
  });

  test("idempotency: second call for same probe writes nothing", () => {
    const iso = "2026-05-24T00:30:02.000Z";
    const topic = "WAKE_SLO_PROBE_C2L_1779582602000";
    const session_id = mintProbeSession(topic);
    const message_id = mintProbeMessage(session_id, `WAKE_SLO_PING ${iso}`);

    const r1 = maybeRespondToProbe({
      workspace_id: WORKSPACE_ID,
      message_id,
      session_id,
      topic,
      body: `WAKE_SLO_PING ${iso}`,
      sender_agent_id: SENDER_ID,
      recipient_agent_id: RECIPIENT_ID,
    });
    expect((r1 as { replied: boolean }).replied).toBe(true);

    const r2 = maybeRespondToProbe({
      workspace_id: WORKSPACE_ID,
      message_id,
      session_id,
      topic,
      body: `WAKE_SLO_PING ${iso}`,
      sender_agent_id: SENDER_ID,
      recipient_agent_id: RECIPIENT_ID,
    });
    expect(r2.matched).toBe(true);
    expect((r2 as { replied: boolean }).replied).toBe(false);
    expect((r2 as { reason: string }).reason).toBe("duplicate");

    const reply_count = db
      .prepare(`SELECT count(*) AS n FROM agent_comm_messages WHERE session_id = ? AND kind = 'reply'`)
      .get(session_id) as { n: number };
    expect(reply_count.n).toBe(1);
  });
});
