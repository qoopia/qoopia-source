import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "../db/connection.ts";
import { QoopiaError } from "../utils/errors.ts";
import { agentReply } from "./agent-comm.ts";
import { boundRuntimeSecret } from "./agent-wake.ts";

/**
 * POST /api/v1/agentcomm/wake-reply — the answer a woken runtime sends back.
 *
 * A wake runner (qoopia wake-runner) runs a real turn of its agent and posts
 * the turn's answer here, signed with the same shared secret Qoopia signs the
 * wake with. It needs no agent key of its own: the AGENTCOMM_<NAME>_WEBHOOK_*
 * binding already says which one agent that runtime serves, and
 * AGENTCOMM_<NAME>_WEBHOOK_AGENT_ID is required — a name alone never proves it.
 *
 * The callback can do exactly one thing: reply, as the bound agent, to a
 * message that was addressed to that agent, in that message's own session.
 */
export const WAKE_REPLY_PATH = "/api/v1/agentcomm/wake-reply";
export const WAKE_REPLY_MAX_BYTES = 64 * 1024;

const input = z.object({
  agent_id: z.string().min(1).max(64),
  reply_to_message_id: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(50_000),
  idempotency_key: z.string().min(1).max(128),
  metadata: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
}).strict();

// ponytail: per-process window; one writer per database today.
const window = new Map<string, number[]>();
const PER_MINUTE = 30;

function sameSecret(expected: string, given: string): boolean {
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function wakeReply(raw: Buffer, headers: Record<string, string | string[] | undefined>):
  { status: number; body: Record<string, unknown> } {
  let parsed: z.infer<typeof input>;
  try {
    parsed = input.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    return { status: 400, body: { error: "invalid_request", error_description: "Expected {agent_id, reply_to_message_id, body, idempotency_key}" } };
  }
  const agent = db.prepare(`SELECT id, name, workspace_id FROM agents WHERE id = ? AND active = 1`)
    .get(parsed.agent_id) as { id: string; name: string; workspace_id: string } | null;
  const bound = agent ? boundRuntimeSecret(agent) : null;
  const header = (name: string) => { const v = headers[name]; return Array.isArray(v) ? v[0] ?? "" : v ?? ""; };
  const signed = bound && (bound.auth === "bearer"
    ? sameSecret(`Bearer ${bound.secret}`, header("authorization"))
    : sameSecret(createHmac("sha256", bound.secret).update(raw).digest("hex"), header("x-webhook-signature")));
  // One answer for an unknown agent, an unbound one and a bad signature: no probing.
  if (!agent || !signed) return { status: 401, body: { error: "unauthorized", error_description: "Unknown runtime or bad signature" } };

  const now = Date.now(), recent = (window.get(agent.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) return { status: 429, body: { error: "rate_limited", error_description: "Too many replies; retry in a minute" } };
  window.set(agent.id, [...recent, now]);

  const message = db.prepare(
    `SELECT id, session_id, sender_agent_id FROM agent_comm_messages WHERE id = ? AND recipient_agent_id = ?`,
  ).get(parsed.reply_to_message_id, agent.id) as { id: string; session_id: string; sender_agent_id: string } | null;
  if (!message) return { status: 404, body: { error: "not_found", error_description: "No such message to this agent" } };
  try {
    const sent = agentReply({
      workspace_id: agent.workspace_id,
      agent_id: agent.id,
      session_id: message.session_id,
      to_agent: message.sender_agent_id,
      reply_to_message_id: message.id,
      body: parsed.body,
      idempotency_key: parsed.idempotency_key,
      metadata: { ...parsed.metadata, via: "wake-runner" },
    });
    return { status: 200, body: sent };
  } catch (error) {
    if (!(error instanceof QoopiaError)) throw error;
    const status = ({ NOT_FOUND: 404, CONFLICT: 409, INVALID_INPUT: 400, FORBIDDEN: 403 } as Record<string, number>)[error.code] ?? 400;
    return { status, body: { error: error.code, error_description: error.message } };
  }
}
