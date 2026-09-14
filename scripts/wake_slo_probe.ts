#!/usr/bin/env bun
/**
 * TEST-ONLY measurement harness. NOT production AgentComm delivery.
 * Polls agent_comm_messages every 1s for ack/reply tracking.
 * Production AgentComm uses the durable wake queue with optional event-push
 * acceleration — see
 * /srv/qoopia/code/src/services/agent-wake.ts.
 * Activated ONLY by HOLD-marked cron after Leo OK + Asхат GO.
 *
 * Wake SLO probe — Phase 1 item 1.
 *
 * Spec: /srv/qoopia/eval/wake-slo-spec.md
 * Migration: /srv/qoopia/code/migrations/016-wake-slo-probes.sql
 *
 * One invocation = one probe row in `wake_slo_probes`. The script runs
 * in-process against the live Qoopia DB and service layer, so the same
 * code paths exercised by real AgentComm traffic are exercised here.
 *
 * Usage:
 *   bun scripts/wake_slo_probe.ts <C2L|L2C>
 */
import { db } from "../src/db/connection.ts";
import {
  agentSessionCreate,
  agentSend,
  agentSessionClose,
} from "../src/services/agent-comm.ts";

type Direction = "C2L" | "L2C";

const DIR = (process.argv[2] || "").toUpperCase() as Direction;
if (DIR !== "C2L" && DIR !== "L2C") {
  console.error("usage: wake_slo_probe.ts <C2L|L2C>");
  process.exit(2);
}

const WORKSPACE_ID = "01KMKRVYF2FN68D9N3C8BEGAHS"; // Default workspace
const DELIVERY_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 90_000;
const POLL_MS = 1_000;

function nowMs(): number {
  return Date.now();
}

function nowIsoMs(): string {
  return new Date().toISOString();
}

function resolveAgentId(name: string): string {
  const row = db
    .prepare(`SELECT id FROM agents WHERE workspace_id = ? AND lower(name) = lower(?) AND active = 1 LIMIT 1`)
    .get(WORKSPACE_ID, name) as { id: string } | undefined;
  if (!row) throw new Error(`agent not found: ${name}`);
  return row.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readMessage(message_id: string): { delivered_at: string | null } | null {
  const row = db
    .prepare(`SELECT delivered_at FROM agent_comm_messages WHERE id = ?`)
    .get(message_id) as { delivered_at: string | null } | undefined;
  return row || null;
}

function findReply(session_id: string, recipient_agent_id: string, after_iso: string): {
  body: string;
  created_at: string;
  metadata: string;
} | null {
  const row = db
    .prepare(
      `SELECT body, created_at, metadata
         FROM agent_comm_messages
        WHERE session_id = ?
          AND recipient_agent_id = ?
          AND kind = 'reply'
          AND created_at > ?
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(session_id, recipient_agent_id, after_iso) as { body: string; created_at: string; metadata: string } | undefined;
  return row || null;
}

function readWakeStatus(message_id: string): string | null {
  const row = db
    .prepare(`SELECT status FROM agent_wake_events WHERE message_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(message_id) as { status: string } | undefined;
  return row ? row.status : null;
}

function isoDiffMs(later: string, earlier: string): number {
  return new Date(later).getTime() - new Date(earlier).getTime();
}

async function probe(direction: Direction): Promise<void> {
  const sender_name = direction === "C2L" ? "corsair-main" : "Leo";
  const recipient_name = direction === "C2L" ? "Leo" : "corsair-main";

  const sender_id = resolveAgentId(sender_name);
  const recipient_id = resolveAgentId(recipient_name);

  const started_at = nowIsoMs();
  const ping_iso = started_at;
  const topic = `WAKE_SLO_PROBE_${direction}_${nowMs()}`;
  const body = `WAKE_SLO_PING ${ping_iso}`;

  let session_id: string | null = null;
  let message_id: string | null = null;
  let wake_attempted = 0;
  let wake_ok = 0;
  let delivery_latency_ms: number | null = null;
  let reply_latency_ms: number | null = null;
  let status: "ok" | "failed" = "failed";
  let error_class:
    | "wake_push_failed"
    | "delivery_timeout"
    | "reply_timeout"
    | "error_envelope"
    | "protocol_mismatch"
    | "unexplained_hang"
    | null = "unexplained_hang";

  try {
    const session = agentSessionCreate({
      workspace_id: WORKSPACE_ID,
      agent_id: sender_id,
      topic,
      metadata: { probe: "wake_slo", direction },
    });
    session_id = session.id;

    const sent = agentSend({
      workspace_id: WORKSPACE_ID,
      agent_id: sender_id,
      to_agent: recipient_name,
      session_id,
      body,
      metadata: { probe: "wake_slo", direction },
    });
    message_id = sent.id;
    wake_attempted = 1;

    // agentSend commits a queued durable event and nudges the asynchronous
    // worker. The delivery/reply polling below remains the end-to-end signal;
    // this immediate sample is only a state snapshot.
    const wstatus = readWakeStatus(message_id);
    if (wstatus === "delivered") wake_ok = 1;
    else if (wstatus === "failed") {
      error_class = "wake_push_failed";
      return;
    }

    // Poll for delivery: the runtime confirming it took the message.
    const delivery_deadline = nowMs() + DELIVERY_TIMEOUT_MS;
    let delivered_at: string | null = null;
    while (nowMs() < delivery_deadline) {
      const m = readMessage(message_id);
      if (m?.delivered_at) {
        delivered_at = m.delivered_at;
        delivery_latency_ms = isoDiffMs(delivered_at, started_at);
        break;
      }
      await sleep(POLL_MS);
    }
    if (!delivered_at) {
      error_class = "delivery_timeout";
      return;
    }

    // Poll for reply.
    const reply_deadline = nowMs() + REPLY_TIMEOUT_MS - DELIVERY_TIMEOUT_MS;
    const adjusted_deadline = Math.max(nowMs() + 1000, reply_deadline);
    let reply: ReturnType<typeof findReply> = null;
    while (nowMs() < adjusted_deadline) {
      reply = findReply(session_id, sender_id, started_at);
      if (reply) break;
      await sleep(POLL_MS);
    }
    if (!reply) {
      error_class = "reply_timeout";
      return;
    }
    reply_latency_ms = isoDiffMs(reply.created_at, started_at);

    const meta = JSON.parse(reply.metadata || "{}");
    if (meta.error === true) {
      error_class = "error_envelope";
      return;
    }

    const expected_prefix = `WAKE_SLO_PONG ${ping_iso}`;
    if (!reply.body.startsWith("WAKE_SLO_PONG ")) {
      error_class = "protocol_mismatch";
      return;
    }
    // Accept either exact echo of our ping_iso or any plausible pong; the
    // strict prefix check above is the protocol gate, the iso match is a
    // sanity check only.
    if (!reply.body.startsWith(expected_prefix)) {
      error_class = "protocol_mismatch";
      return;
    }

    status = "ok";
    error_class = null;
  } finally {
    if (session_id) {
      try {
        agentSessionClose({
          workspace_id: WORKSPACE_ID,
          agent_id: sender_id,
          session_id,
          reason: status === "ok" ? "probe_ok" : `probe_failed:${error_class}`,
        });
      } catch {
        /* swallow — recording is the primary concern */
      }
    }

    db.prepare(
      `INSERT INTO wake_slo_probes
         (direction, started_at, wake_attempted, wake_ok, delivery_latency_ms,
          reply_latency_ms, status, error_class, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      direction,
      started_at,
      wake_attempted,
      wake_ok,
      delivery_latency_ms,
      reply_latency_ms,
      status,
      error_class,
      session_id,
    );

    const out = {
      direction,
      started_at,
      wake_attempted,
      wake_ok,
      delivery_latency_ms,
      reply_latency_ms,
      status,
      error_class,
      session_id,
    };
    console.log(JSON.stringify(out));
  }
}

await probe(DIR);
process.exit(0);
