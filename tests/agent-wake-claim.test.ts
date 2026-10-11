import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { DB_PATH, db } from "../src/db/connection.ts";
import { openWritableDatabase } from "../src/db/sqlite.ts";
import { acquireWakeClaim, drainAgentWakeQueue, releaseWakeClaim, renewWakeClaim } from "../src/services/agent-wake.ts";

// Two writer processes on one database file: `db` is this process, `other` an
// independent connection standing in for a second server.
let other: Database;
let workspaceId = "", senderId = "", targetId = "";
let server: ReturnType<typeof Bun.serve> | null = null;
const received: any[] = [];
let respondAfterMs = 0;

beforeAll(() => {
  runMigrations();
  other = openWritableDatabase(DB_PATH, { wal: true });
  const workspace = createWorkspace({ name: "Wake Claim", slug: "wake-claim" });
  workspaceId = workspace.id;
  senderId = createAgent({ name: "claim-sender", workspaceSlug: workspace.slug }).id;
  targetId = createAgent({ name: "claim-target", workspaceSlug: workspace.slug }).id;
  server = Bun.serve({ port: 0, fetch: async (request) => {
    received.push(await request.json());
    await Bun.sleep(respondAfterMs);
    return Response.json({ accepted: true }, { status: 202 });
  } });
  process.env.AGENTCOMM_CLAIM_TARGET_WEBHOOK_URL = `http://127.0.0.1:${server.port}/wake`;
  process.env.AGENTCOMM_CLAIM_TARGET_WEBHOOK_TOKEN = "test-only-claim-token";
});

afterAll(() => {
  server?.stop();
  other?.close();
  delete process.env.AGENTCOMM_CLAIM_TARGET_WEBHOOK_URL;
  delete process.env.AGENTCOMM_CLAIM_TARGET_WEBHOOK_TOKEN;
});

function seedWake(body: string, at = new Date().toISOString()): { eventId: string; messageId: string } {
  const sessionId = ulid(), messageId = ulid(), eventId = ulid();
  db.transaction(() => {
    db.prepare(`INSERT INTO agent_comm_sessions (id, workspace_id, topic, status, created_by_agent_id, metadata, created_at, updated_at)
      VALUES (?, ?, 'claim test', 'open', ?, '{}', ?, ?)`).run(sessionId, workspaceId, senderId, at, at);
    db.prepare(`INSERT INTO agent_comm_messages (id, workspace_id, session_id, sender_agent_id, recipient_agent_id, kind, body, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, 'request', ?, '{}', ?)`).run(messageId, workspaceId, sessionId, senderId, targetId, body, at);
    db.prepare(`INSERT INTO agent_wake_events (id, workspace_id, target_agent_id, session_id, message_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, '{}', ?)`).run(eventId, workspaceId, targetId, sessionId, messageId, at);
  })();
  return { eventId, messageId };
}

const wake = (eventId: string) =>
  db.prepare(`SELECT status, attempt_count FROM agent_wake_events WHERE id = ?`).get(eventId) as { status: string; attempt_count: number };

test("two writers never hold one recipient at once; only the holder renews or releases", () => {
  const mine = acquireWakeClaim(targetId, db)!;
  expect(mine).toBeString();
  expect(acquireWakeClaim(targetId, other)).toBeNull();
  expect(renewWakeClaim(targetId, "not-the-holder", other)).toBe(false);
  expect(releaseWakeClaim(targetId, "not-the-holder", other)).toBe(false);
  expect(acquireWakeClaim(targetId, other)).toBeNull();
  expect(renewWakeClaim(targetId, mine, other)).toBe(true);
  // The losers asked for a rerun, so the holder re-drives on release.
  expect(releaseWakeClaim(targetId, mine, db)).toBe(true);
  const theirs = acquireWakeClaim(targetId, other)!;
  expect(theirs).toBeString();
  expect(releaseWakeClaim(targetId, theirs, other)).toBe(false);
});

test("a crashed holder's lapsed lease is taken over, and its late release cannot free the new one", () => {
  const crashed = acquireWakeClaim(targetId, other)!;
  expect(acquireWakeClaim(targetId, db)).toBeNull();
  other.prepare(`UPDATE agent_wake_claims SET lease_until = ? WHERE target_agent_id = ?`)
    .run(new Date(Date.now() - 1).toISOString(), targetId);
  const taker = acquireWakeClaim(targetId, db)!;
  expect(taker).toBeString();
  expect(renewWakeClaim(targetId, crashed, other)).toBe(false);
  expect(releaseWakeClaim(targetId, crashed, other)).toBe(false);
  expect(acquireWakeClaim(targetId, other)).toBeNull();
  // The rerun asked of the crashed holder carries over to the one that took over.
  expect(releaseWakeClaim(targetId, taker, db)).toBe(true);
});

test("a wake that arrives while another writer delivers waits without spending an attempt, then goes out once", async () => {
  received.length = 0;
  const inFlight = acquireWakeClaim(targetId, other)!;
  const late = seedWake("arrived mid-delivery");

  expect(await drainAgentWakeQueue({ eventId: late.eventId })).toEqual([]);
  expect(wake(late.eventId)).toEqual({ status: "queued", attempt_count: 0 });
  expect(received).toHaveLength(0);

  // The other writer finishes and sees the rerun its loser asked for.
  expect(releaseWakeClaim(targetId, inFlight, other)).toBe(true);
  const [result] = await drainAgentWakeQueue({ eventId: late.eventId });
  expect(result).toMatchObject({ status: "delivered" });
  expect(wake(late.eventId)).toEqual({ status: "delivered", attempt_count: 1 });
  expect(received.flatMap((p) => p.messages.map((m: any) => m.message_id))).toEqual([late.messageId]);
  expect(db.prepare(`SELECT 1 FROM agent_wake_claims WHERE target_agent_id = ?`).get(targetId)).toBeNull();
});

test("wakes that lose to an in-flight delivery are all re-driven by its holder, older and newer alike", async () => {
  received.length = 0;
  respondAfterMs = 150;
  const base = Date.now() - 10_000;
  try {
    const first = seedWake("in flight", new Date(base).toISOString());
    const inFlight = drainAgentWakeQueue({ eventId: first.eventId });
    const second = seedWake("waits 1", new Date(base + 1_000).toISOString());
    const third = seedWake("waits 2", new Date(base + 2_000).toISOString());
    await Promise.all([inFlight, drainAgentWakeQueue({ eventId: second.eventId }), drainAgentWakeQueue({ eventId: third.eventId })]);
    for (let i = 0; i < 80 && wake(third.eventId).status !== "delivered"; i++) await Bun.sleep(25);
    expect([first, second, third].map(({ eventId }) => wake(eventId).status)).toEqual(["delivered", "delivered", "delivered"]);
    const copies = received.flatMap((p) => p.messages.map((m: any) => m.message_id));
    expect(copies.sort()).toEqual([first.messageId, second.messageId, third.messageId].sort());
  } finally {
    respondAfterMs = 0;
  }
});

test("a drain takes over the lease of a writer that crashed mid-delivery", async () => {
  received.length = 0;
  acquireWakeClaim(targetId, other);
  other.prepare(`UPDATE agent_wake_claims SET lease_until = ? WHERE target_agent_id = ?`)
    .run(new Date(Date.now() - 1).toISOString(), targetId);
  const stranded = seedWake("stranded by a crash");
  const [result] = await drainAgentWakeQueue({ eventId: stranded.eventId });
  expect(result).toMatchObject({ status: "delivered" });
  expect(received).toHaveLength(1);
});
