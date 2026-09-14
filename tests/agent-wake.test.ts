import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ulid } from "ulid";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import {
  AGENT_WAKE_MAX_ATTEMPTS,
  drainAgentWakeQueue,
} from "../src/services/agent-wake.ts";

let workspaceId = "";
let senderId = "";
let targetId = "";
let leoId = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Wake Worker", slug: "wake-worker" });
  workspaceId = workspace.id;
  senderId = createAgent({ name: "wake-sender", workspaceSlug: workspace.slug }).id;
  targetId = createAgent({ name: "wake-target", workspaceSlug: workspace.slug }).id;
  leoId = createAgent({ name: "Leo", workspaceSlug: workspace.slug }).id;
});

// Each test starts from a clean transport and a clean queue. Wake delivery now
// re-carries anything still undelivered for the same recipient, so a leftover
// event from an earlier test would otherwise ride along and change what the
// next test observes.
beforeEach(() => {
  server?.stop();
  server = null;
  delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL;
  delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN;
  delete process.env.AGENTCOMM_LEO_WEBHOOK_URL;
  delete process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN;
  db.prepare(`DELETE FROM agent_wake_events WHERE delivered_at IS NULL`).run();
});

afterAll(() => {
  server?.stop();
  delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL;
  delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN;
  delete process.env.AGENTCOMM_LEO_WEBHOOK_URL;
  delete process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN;
});

function seedWake(options: {
  targetId?: string;
  body?: string;
  kind?: "request" | "ack" | "reply" | "status" | "system";
  createdAt?: string;
  status?: "queued" | "delivered" | "failed" | "ignored";
  attemptCount?: number;
  nextAttemptAt?: string | null;
} = {}): { eventId: string; messageId: string } {
  const target = options.targetId ?? targetId;
  const sessionId = ulid();
  const messageId = ulid();
  const eventId = ulid();
  const createdAt = options.createdAt ?? new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_comm_sessions
         (id, workspace_id, topic, status, created_by_agent_id, metadata, created_at, updated_at)
       VALUES (?, ?, 'wake worker test', 'open', ?, '{}', ?, ?)`,
    ).run(sessionId, workspaceId, senderId, createdAt, createdAt);
    db.prepare(
      `INSERT INTO agent_comm_messages
         (id, workspace_id, session_id, sender_agent_id, recipient_agent_id,
          kind, body, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(
      messageId,
      workspaceId,
      sessionId,
      senderId,
      target,
      options.kind ?? "request",
      options.body ?? "wake worker payload",
      createdAt,
    );
    db.prepare(
      `INSERT INTO agent_wake_events
         (id, workspace_id, target_agent_id, session_id, message_id, status,
          payload, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    ).run(
      eventId,
      workspaceId,
      target,
      sessionId,
      messageId,
      options.status ?? "queued",
      options.attemptCount ?? 0,
      options.nextAttemptAt ?? null,
      createdAt,
    );
  })();
  return { eventId, messageId };
}

type WakeState = {
  status: string;
  attempt_count: number;
  delivered_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
};

function wakeRow(eventId: string): WakeState {
  return db.prepare(
    `SELECT status, attempt_count, delivered_at, next_attempt_at, last_error
       FROM agent_wake_events WHERE id = ?`,
  ).get(eventId) as WakeState;
}

/** What a recipient runtime returns once it has accepted the messages. */
function accepted(): Response {
  return Response.json({ accepted: true, hook_id: "test" }, { status: 202 });
}

describe("durable AgentComm wake lifecycle", () => {
  test("a confirmed acceptance marks a claimed event delivered", async () => {
    let received = 0;
    let payload: any = null;
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received++;
        payload = await request.json();
        expect(payload.event_type).toBe("agentcomm_wake");
        return accepted();
      },
    });
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN = "test-only-wake-token";

    const { eventId } = seedWake();
    const result = await drainAgentWakeQueue({ eventId });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("delivered");
    expect(received).toBe(1);
    expect(wakeRow(eventId)).toMatchObject({
      status: "delivered",
      attempt_count: 1,
      next_attempt_at: null,
      last_error: null,
    });
    expect(wakeRow(eventId).delivered_at).not.toBeNull();
    // The wake carries the message itself, so the recipient runtime can put it
    // straight into the turn instead of being told to go and fetch it.
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toMatchObject({ body: "wake worker payload" });
    expect(payload.message_count).toBe(1);
    server.stop();
    server = null;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN;
  });

  test("a 2xx without an acceptance body is not a delivery", async () => {
    // A status code can come from a proxy, a redirect target or a health
    // endpoint. Only the runtime's own acknowledgement proves the messages
    // reached a turn, so anything else is retried rather than written off.
    server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true }, { status: 200 }),
    });
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN = "test-only-wake-token";

    const { eventId } = seedWake();
    const result = await drainAgentWakeQueue({ eventId });
    expect(result[0]).toMatchObject({
      status: "failed",
      attempted: true,
      http_status: 200,
      error: "runtime_did_not_confirm_acceptance",
    });
    expect(wakeRow(eventId).delivered_at).toBeNull();

    server.stop();
    server = null;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN;
  });

  test("an undelivered message rides along with the next wake and is delivered with it", async () => {
    // This is what stops a backlog forming: nothing waits for the recipient to
    // come and collect it, the next wake re-carries whatever is still undelivered.
    const stranded = seedWake({ body: "stranded earlier message", createdAt: new Date(Date.now() - 60_000).toISOString() });
    let payload: any = null;
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        payload = await request.json();
        return accepted();
      },
    });
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN = "test-only-wake-token";

    const fresh = seedWake({ body: "the message that triggered this wake" });
    const result = await drainAgentWakeQueue({ eventId: fresh.eventId });

    expect(result[0]?.status).toBe("delivered");
    expect(payload.messages.map((m: any) => m.body)).toEqual([
      "stranded earlier message",
      "the message that triggered this wake",
    ]);
    // Both are recorded delivered, with no action at all from the recipient.
    expect(wakeRow(fresh.eventId).delivered_at).not.toBeNull();
    expect(wakeRow(stranded.eventId).delivered_at).not.toBeNull();
    expect(wakeRow(stranded.eventId).status).toBe("delivered");

    server.stop();
    server = null;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN;
  });

  test("history older than the lookback window is not replayed into a turn", async () => {
    // Rescuing a recipient that was down is worth doing; replaying month-old
    // traffic is noise. The old message stays readable via agent_inbox.
    const ancient = seedWake({
      body: "message from last month",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    });
    let payload: any = null;
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        payload = await request.json();
        return accepted();
      },
    });
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN = "test-only-wake-token";

    const fresh = seedWake({ body: "today's message" });
    await drainAgentWakeQueue({ eventId: fresh.eventId });

    expect(payload.messages.map((m: any) => m.body)).toEqual(["today's message"]);
    expect(wakeRow(ancient.eventId).delivered_at).toBeNull();

    server.stop();
    server = null;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL;
    delete process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN;
  });

  test("missing optional transport marks event ignored; durable inbox remains canonical", async () => {
    const { eventId } = seedWake();
    const result = await drainAgentWakeQueue({ eventId });
    expect(result[0]).toMatchObject({
      status: "ignored",
      attempted: false,
      error: "no_webhook_config",
    });
    expect(wakeRow(eventId).status).toBe("ignored");
  });

  test("stale direct Leo callback on loopback:8645 is explicitly disabled", async () => {
    process.env.AGENTCOMM_LEO_WEBHOOK_URL = "http://127.0.0.1:8645/agentcomm";
    process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN = "test-only-leo-token";
    const { eventId } = seedWake({ targetId: leoId });
    const result = await drainAgentWakeQueue({ eventId });
    expect(result[0]).toMatchObject({
      status: "ignored",
      attempted: false,
      error: "stale_direct_callback_disabled",
    });
  });

  test("new Leo endpoint is delivered and carries the message body", async () => {
    let receivedPath = "";
    let receivedBody: Record<string, unknown> = {};
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        receivedPath = new URL(request.url).pathname;
        receivedBody = await request.json() as Record<string, unknown>;
        return accepted();
      },
    });
    process.env.AGENTCOMM_LEO_WEBHOOK_URL =
      `http://127.0.0.1:${server.port}/webhooks/agentcomm-leo-v4`;
    process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN = "test-only-leo-token";
    const { eventId, messageId } = seedWake({
      targetId: leoId,
      kind: "reply",
    });

    const result = await drainAgentWakeQueue({ eventId });
    expect(result[0]).toMatchObject({
      status: "delivered",
      attempted: true,
      http_status: 202,
    });
    expect(receivedPath).toBe("/webhooks/agentcomm-leo-v4");
    expect(receivedBody).toMatchObject({
      event_type: "agentcomm_wake",
      message_id: messageId,
      kind: "reply",
    });
    expect((receivedBody.messages as any[])[0]).toMatchObject({
      message_id: messageId,
      kind: "reply",
    });
    server.stop();
    server = null;
    delete process.env.AGENTCOMM_LEO_WEBHOOK_URL;
    delete process.env.AGENTCOMM_LEO_WEBHOOK_TOKEN;
  });

  test("old queued events are retired without replaying stale notifications", async () => {
    const createdAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const { eventId } = seedWake({ createdAt });
    const result = await drainAgentWakeQueue({ eventId });
    expect(result[0]).toMatchObject({
      status: "ignored",
      attempted: false,
      error: "stale_queued_event",
    });
  });

  test("transport failure persists retry state instead of throwing from send", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 503 }) });
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN = "test-only-wake-token";
    const { eventId } = seedWake();
    const result = await drainAgentWakeQueue({ eventId });
    expect(result[0]).toMatchObject({
      status: "failed",
      attempted: true,
      http_status: 503,
      error: "http_503",
    });
    expect(wakeRow(eventId)).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error: "http_503",
    });
    expect(wakeRow(eventId).next_attempt_at).not.toBeNull();
    server.stop();
    server = null;
  });

  test("an expired queued claim at the attempt ceiling is retired without another POST", async () => {
    let received = 0;
    server = Bun.serve({
      port: 0,
      fetch: () => {
        received++;
        return new Response("ok");
      },
    });
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_WAKE_TARGET_WEBHOOK_TOKEN = "test-only-wake-token";
    const { eventId } = seedWake({
      attemptCount: AGENT_WAKE_MAX_ATTEMPTS,
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(await drainAgentWakeQueue({ eventId })).toEqual([]);
    expect(received).toBe(0);
    expect(wakeRow(eventId)).toMatchObject({
      status: "failed",
      attempt_count: AGENT_WAKE_MAX_ATTEMPTS,
      next_attempt_at: null,
      last_error: "attempt_ceiling_exhausted",
    });
    server.stop();
    server = null;
  });
});
