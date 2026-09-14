/**
 * Pull-side delivery: an agent reading its own inbox is delivery.
 *
 * Some agents are not processes. A public MCP connector is opened by its owner
 * out of the cloud; a CLI session exists for the length of one invocation.
 * There is no address to push a wake to and there never will be, and a webhook
 * that answered accepted:true on their behalf would record a delivery that
 * never happened. What is true instead is that these clients read their inbox
 * — that is the only way they work at all — and the moment a message is in
 * that result, it is in their context.
 *
 * So this file pins down that agent_inbox stamps delivered_at on exactly what
 * it hands back, once, to the calling agent only, and that doing so does not
 * disturb the push path or leave a wake behind to fail noisily later.
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
import { db } from "../src/db/connection.ts";
import { agentInbox, agentSend } from "../src/services/agent-comm.ts";
import { drainAgentWakeQueue } from "../src/services/agent-wake.ts";

let WORKSPACE = "";
let SENDER = "";
/** Stands in for GPT/Claude: a real agent with no webhook, ever. */
let PULLER = "";
let BYSTANDER = "";
/** Has a runtime, so it exercises the push path unchanged. */
let PUSHED = "";

let server: ReturnType<typeof Bun.serve> | null = null;

const WEBHOOK_ENVS = [
  "AGENTCOMM_INBOXDEL_PUSHED_WEBHOOK_URL",
  "AGENTCOMM_INBOXDEL_PUSHED_WEBHOOK_SECRET",
  "AGENTCOMM_INBOXDEL_PUSHED_WEBHOOK_TOKEN",
];

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Inbox Delivery", slug: "inbox-delivery" });
  WORKSPACE = workspace.id;
  SENDER = createAgent({ name: "inboxdel-sender", workspaceSlug: workspace.slug }).id;
  PULLER = createAgent({ name: "inboxdel-puller", workspaceSlug: workspace.slug }).id;
  BYSTANDER = createAgent({ name: "inboxdel-bystander", workspaceSlug: workspace.slug }).id;
  PUSHED = createAgent({ name: "inboxdel-pushed", workspaceSlug: workspace.slug }).id;
});

beforeEach(() => {
  server?.stop();
  server = null;
  for (const key of WEBHOOK_ENVS) delete process.env[key];
  // Undelivered leftovers ride along with the next wake; drop them so each
  // test observes only its own payload.
  db.prepare(`DELETE FROM agent_wake_events WHERE delivered_at IS NULL`).run();
});

afterAll(() => {
  server?.stop();
  for (const key of WEBHOOK_ENVS) delete process.env[key];
});

function messageDeliveredAt(messageId: string): string | null {
  const row = db.prepare(
    `SELECT delivered_at FROM agent_comm_messages WHERE id = ?`,
  ).get(messageId) as { delivered_at: string | null };
  return row.delivered_at;
}

function wakeFor(messageId: string) {
  return db.prepare(
    `SELECT status, delivered_at, next_attempt_at, last_error, attempt_count
       FROM agent_wake_events WHERE message_id = ?`,
  ).get(messageId) as {
    status: string;
    delivered_at: string | null;
    next_attempt_at: string | null;
    last_error: string | null;
    attempt_count: number;
  };
}

function send(to: string, body: string) {
  return agentSend({
    workspace_id: WORKSPACE,
    agent_id: SENDER,
    to_agent: to,
    body,
    topic: "inbox delivery",
  });
}

describe("agent_inbox records delivery", () => {
  test("a message nobody can be pushed to is delivered when its recipient reads it", async () => {
    const sent = send(PULLER, "no runtime to push to");
    await drainAgentWakeQueue();

    // No webhook: the wake gives up in a second and never retries. Before the
    // pull, this message has reached nobody.
    expect(messageDeliveredAt(sent.id)).toBeNull();
    expect(wakeFor(sent.id).status).toBe("ignored");

    const inbox = agentInbox({ workspace_id: WORKSPACE, agent_id: PULLER });
    const item = inbox.items.find((m) => m.id === sent.id);
    expect(item).toBeTruthy();
    // The caller is told the truth in the same breath it is recorded.
    expect(item!.delivered_at).toBeTruthy();
    expect(messageDeliveredAt(sent.id)).toBe(item!.delivered_at);
  });

  test("reading again does not restamp what was already delivered", () => {
    const sent = send(PULLER, "read me twice");
    const first = agentInbox({ workspace_id: WORKSPACE, agent_id: PULLER })
      .items.find((m) => m.id === sent.id)!.delivered_at;
    expect(first).toBeTruthy();

    const second = agentInbox({ workspace_id: WORKSPACE, agent_id: PULLER })
      .items.find((m) => m.id === sent.id)!.delivered_at;
    expect(second).toBe(first);
    expect(messageDeliveredAt(sent.id)).toBe(first);
  });

  test("reading an inbox delivers nothing addressed to anyone else", () => {
    const mine = send(PULLER, "for the puller");
    const theirs = send(BYSTANDER, "for the bystander");

    const inbox = agentInbox({ workspace_id: WORKSPACE, agent_id: PULLER });
    expect(inbox.items.some((m) => m.id === mine.id)).toBe(true);
    expect(inbox.items.some((m) => m.id === theirs.id)).toBe(false);

    expect(messageDeliveredAt(mine.id)).toBeTruthy();
    expect(messageDeliveredAt(theirs.id)).toBeNull();
  });

  test("only what the page actually returned is stamped", () => {
    const older = send(PULLER, "older, off the page");
    // The inbox orders by created_at DESC, id DESC. Two sends inside the same
    // millisecond share created_at, so the tie falls to a random ULID suffix and
    // "newest" becomes a coin flip — this test failed roughly every other run.
    // The product does not promise an order for same-millisecond messages, so
    // give them distinct timestamps instead of asserting one it never made.
    Bun.sleepSync(2);
    const newer = send(PULLER, "newest, on the page");

    const inbox = agentInbox({ workspace_id: WORKSPACE, agent_id: PULLER, limit: 1 });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.id).toBe(newer.id);

    expect(messageDeliveredAt(newer.id)).toBeTruthy();
    expect(messageDeliveredAt(older.id)).toBeNull();
  });

  test("a message already pulled leaves no wake to fail later", async () => {
    const sent = send(PULLER, "pulled before the transport ran");
    agentInbox({ workspace_id: WORKSPACE, agent_id: PULLER });

    // The wake is closed as delivered, so the worker has nothing to pick up
    // and nothing to complain about.
    const before = wakeFor(sent.id);
    expect(before.status).toBe("delivered");
    expect(before.delivered_at).toBeTruthy();
    expect(before.next_attempt_at).toBeNull();
    expect(before.last_error).toBeNull();

    await drainAgentWakeQueue();
    const after = wakeFor(sent.id);
    expect(after.status).toBe("delivered");
    expect(after.attempt_count).toBe(before.attempt_count);
    expect(after.last_error).toBeNull();
  });
});

describe("the push path is unchanged", () => {
  test("a runtime that confirms acceptance still delivers by push", async () => {
    let hits = 0;
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        hits += 1;
        const body = (await request.json()) as { messages?: unknown[] };
        expect(Array.isArray(body.messages)).toBe(true);
        return Response.json({ accepted: true }, { status: 202 });
      },
    });
    process.env.AGENTCOMM_INBOXDEL_PUSHED_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_INBOXDEL_PUSHED_WEBHOOK_TOKEN = "test-secret";

    const sent = send(PUSHED, "pushed and accepted");
    await drainAgentWakeQueue();

    expect(hits).toBeGreaterThan(0);
    expect(messageDeliveredAt(sent.id)).toBeTruthy();
    const wake = wakeFor(sent.id);
    expect(wake.status).toBe("delivered");
    expect(wake.delivered_at).toBeTruthy();
  });

  test("a bare 2xx without accepted:true is still not delivery", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    process.env.AGENTCOMM_INBOXDEL_PUSHED_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
    process.env.AGENTCOMM_INBOXDEL_PUSHED_WEBHOOK_TOKEN = "test-secret";

    const sent = send(PUSHED, "2xx is not acceptance");
    await drainAgentWakeQueue();

    expect(messageDeliveredAt(sent.id)).toBeNull();
    const wake = wakeFor(sent.id);
    expect(wake.status).toBe("failed");
    expect(wake.delivered_at).toBeNull();
  });
});
