import { beforeAll, describe, expect, test } from "bun:test";
import { ulid } from "ulid";
import { createAgent } from "../src/admin/agents.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AGENT_WAKE_MAX_ATTEMPTS } from "../src/services/agent-wake.ts";
import { pruneTerminalAgentWakeEvents } from "../src/services/retention.ts";

let workspaceId = "";
let senderId = "";
let targetId = "";

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({
    name: "Wake Retention",
    slug: "wake-retention",
  });
  workspaceId = workspace.id;
  senderId = createAgent({
    name: "wake-retention-sender",
    workspaceSlug: workspace.slug,
  }).id;
  targetId = createAgent({
    name: "wake-retention-target",
    workspaceSlug: workspace.slug,
  }).id;
});

function seedWake(options: {
  status: "queued" | "delivered" | "failed" | "ignored";
  attemptCount: number;
  createdAt: string;
  nextAttemptAt?: string | null;
}): string {
  const sessionId = ulid();
  const messageId = ulid();
  const eventId = ulid();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_comm_sessions
         (id, workspace_id, topic, status, created_by_agent_id, metadata, created_at, updated_at)
       VALUES (?, ?, 'wake retention test', 'open', ?, '{}', ?, ?)`,
    ).run(sessionId, workspaceId, senderId, options.createdAt, options.createdAt);
    db.prepare(
      `INSERT INTO agent_comm_messages
         (id, workspace_id, session_id, sender_agent_id, recipient_agent_id,
          kind, body, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, 'request', 'retention payload', '{}', ?)`,
    ).run(messageId, workspaceId, sessionId, senderId, targetId, options.createdAt);
    db.prepare(
      `INSERT INTO agent_wake_events
         (id, workspace_id, target_agent_id, session_id, message_id, status,
          payload, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    ).run(
      eventId,
      workspaceId,
      targetId,
      sessionId,
      messageId,
      options.status,
      options.attemptCount,
      options.nextAttemptAt ?? null,
      options.createdAt,
    );
  })();
  return eventId;
}

describe("AgentComm wake retention", () => {
  test("prunes only old terminal rows and preserves retryable or recent rows", () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    const recent = new Date().toISOString();
    const oldDelivered = seedWake({ status: "delivered", attemptCount: 1, createdAt: old });
    const oldIgnored = seedWake({ status: "ignored", attemptCount: 1, createdAt: old });
    const oldExhausted = seedWake({
      status: "failed",
      attemptCount: AGENT_WAKE_MAX_ATTEMPTS,
      createdAt: old,
    });
    const oldRetryableFailed = seedWake({
      status: "failed",
      attemptCount: AGENT_WAKE_MAX_ATTEMPTS - 1,
      nextAttemptAt: old,
      createdAt: old,
    });
    const oldQueued = seedWake({ status: "queued", attemptCount: 0, createdAt: old });
    const recentDelivered = seedWake({
      status: "delivered",
      attemptCount: 1,
      createdAt: recent,
    });

    expect(pruneTerminalAgentWakeEvents()).toBe(3);
    const remaining = db.prepare(
      `SELECT id FROM agent_wake_events WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id`,
    ).all(
      oldDelivered,
      oldIgnored,
      oldExhausted,
      oldRetryableFailed,
      oldQueued,
      recentDelivered,
    ) as Array<{ id: string }>;
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [oldRetryableFailed, oldQueued, recentDelivered].sort(),
    );
  });
});
