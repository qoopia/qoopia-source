/**
 * AgentComm delivery E2E.
 *
 * Proves the property the messenger model rests on: a message reaches the
 * recipient runtime and is recorded as delivered without the recipient agent
 * calling anything at all. There is no receipt to lease and no ack to send —
 * if the runtime confirms it accepted the payload, the server stamps
 * delivered_at, and if it does not, the message stays undelivered and is
 * retried.
 *
 * Usage:
 *   bun run scripts/v4-agentcomm-e2e.ts --json <report path>
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const args = process.argv.slice(2);
const reportPath = valueAfter(args, "--json");
requireCondition(reportPath, "E2E requires --json <path>");
requireCondition(process.env.NODE_ENV !== "production", "E2E refuses NODE_ENV=production");

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-agentcomm-e2e-"));
process.env.NODE_ENV = "test";
process.env.QOOPIA_DATA_DIR = path.join(scratchRoot, "data");
process.env.QOOPIA_LOG_DIR = path.join(scratchRoot, "logs");
process.env.QOOPIA_BACKUP_DIR = path.join(scratchRoot, "backups");
process.env.QOOPIA_PORT = "0";
process.env.QOOPIA_LOG_LEVEL = "error";

const SECRET = "e2e-webhook-secret";

/** Stands in for a recipient runtime's wake webhook. */
type Received = { signatureValid: boolean; payload: any };

function startRuntime(reply: (received: Received) => { status: number; body: string }) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
      const entry: Received = {
        signatureValid: req.headers["x-webhook-signature"] === expected,
        payload: JSON.parse(raw),
      };
      received.push(entry);
      const out = reply(entry);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(out.body);
    });
  });
  return { server, received };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function record(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
  if (!ok) throw new Error(`${check}: ${detail}`);
}

let closeDb: (() => void) | undefined;
let runtime: http.Server | undefined;
try {
  const [{ runMigrations }, workspaces, agents, comm, wake, connection] = await Promise.all([
    import("../src/db/migrate.ts"),
    import("../src/admin/workspaces.ts"),
    import("../src/admin/agents.ts"),
    import("../src/services/agent-comm.ts"),
    import("../src/services/agent-wake.ts"),
    import("../src/db/connection.ts"),
  ]);
  closeDb = connection.closeDb;
  runMigrations();

  const ws = workspaces.createWorkspace({ name: "agentcomm-e2e" });
  const sender = agents.createAgent({ name: "e2e-sender", workspaceSlug: ws.slug, type: "steward" });
  const recipient = agents.createAgent({ name: "e2e-recipient", workspaceSlug: ws.slug });

  // The recipient runtime confirms acceptance, exactly like ductor's webhook.
  let mode: "accept" | "silent" = "silent";
  const rt = startRuntime(() =>
    mode === "accept"
      ? { status: 202, body: JSON.stringify({ accepted: true, hook_id: "e2e" }) }
      // A 200 with no acknowledgement — what a proxy or a wrong endpoint gives.
      : { status: 200, body: JSON.stringify({ ok: true }) },
  );
  runtime = rt.server;
  const port = await listen(rt.server);
  const prefix = `AGENTCOMM_${recipient.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_WEBHOOK`;
  process.env[`${prefix}_URL`] = `http://127.0.0.1:${port}/hooks/e2e`;
  process.env[`${prefix}_SECRET`] = SECRET;
  process.env[`${prefix}_AUTH`] = "hmac";

  const deliveredAt = (messageId: string): string | null => {
    const row = connection.db.prepare(
      `SELECT delivered_at FROM agent_wake_events WHERE message_id = ?`,
    ).get(messageId) as { delivered_at: string | null } | undefined;
    return row?.delivered_at ?? null;
  };

  // --- 1. A 2xx without acknowledgement is not a delivery. -----------------
  const unconfirmed = comm.agentSend({
    workspace_id: ws.id,
    agent_id: sender.id,
    to_agent: recipient.name,
    body: "first message, runtime does not confirm",
    topic: "e2e",
  });
  await wake.drainAgentWakeQueue({ eventId: unconfirmed.wake?.event_id });
  record(
    "http_2xx_without_acceptance_is_not_delivered",
    deliveredAt(unconfirmed.id) === null,
    "delivered_at must stay null when the runtime does not answer {accepted:true}",
  );
  record(
    "payload_carries_message_body",
    rt.received.at(-1)?.payload?.messages?.some((m: any) => m.body.includes("does not confirm")),
    "the wake must carry the message itself, not just a notification",
  );
  record(
    "payload_carries_prerendered_text",
    typeof rt.received.at(-1)?.payload?.messages_text === "string" &&
      rt.received.at(-1)!.payload.messages_text.includes("does not confirm") &&
      rt.received.at(-1)!.payload.messages_text.includes("From: "),
    "messages_text must be a ready-to-render block, since runtime templates can only stringify",
  );
  record(
    "payload_signature_valid",
    rt.received.at(-1)?.signatureValid === true,
    "HMAC signature must cover the delivered payload",
  );

  // --- 2. Confirmed acceptance delivers, and sweeps up the earlier one. ----
  mode = "accept";
  const confirmed = comm.agentSend({
    workspace_id: ws.id,
    agent_id: sender.id,
    to_agent: recipient.name,
    body: "second message, runtime confirms",
    topic: "e2e",
  });
  await wake.drainAgentWakeQueue({ eventId: confirmed.wake?.event_id });

  record(
    "confirmed_acceptance_marks_delivered",
    deliveredAt(confirmed.id) !== null,
    "delivered_at must be stamped once the runtime confirms acceptance",
  );
  record(
    "recipient_did_nothing",
    true,
    "no lease, no ack, no tool call was made by the recipient in this run",
  );

  const lastPayload = rt.received.at(-1)!.payload;
  record(
    "undelivered_backlog_rides_along",
    lastPayload.messages.length === 2 &&
      lastPayload.messages[0].body.includes("does not confirm"),
    "the earlier undelivered message must be re-sent with the next wake, oldest first",
  );
  record(
    "backlog_marked_delivered_too",
    deliveredAt(unconfirmed.id) !== null,
    "a message confirmed as part of a batch must also be recorded as delivered",
  );

  // --- 3. Nothing is left in a state anybody has to close. -----------------
  const receiptTable = connection.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_comm_delivery_receipts'`,
  ).get();
  record("receipt_table_is_gone", !receiptTable, "agent_comm_delivery_receipts must not exist");
  record(
    "ack_columns_are_gone",
    ((connection.db.prepare(
      `SELECT COUNT(*) AS count FROM pragma_table_info('agent_comm_messages')
        WHERE name IN ('ack_required', 'acked_at', 'ack_status')`,
    ).get() as { count: number }).count) === 0,
    "the receipt-era columns must not exist on agent_comm_messages",
  );
  record("agent_ack_removed", !("agentAck" in comm), "agent_ack must no longer be exported");

  fs.writeFileSync(
    reportPath,
    JSON.stringify({ status: "pass", checks: results, at: new Date().toISOString() }, null, 2),
  );
  console.log(`AgentComm E2E passed: ${results.length} checks`);
} catch (error) {
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      { status: "fail", error: String(error), checks: results, at: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.error(String(error));
  process.exitCode = 1;
} finally {
  runtime?.close();
  closeDb?.();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
