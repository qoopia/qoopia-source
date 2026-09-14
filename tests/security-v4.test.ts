import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrationsToDatabase } from "../src/db/v4-migrations.ts";
import { configureWritableDatabase } from "../src/db/sqlite.ts";
import {
  OUTBOX_MAX_ATTEMPTS,
  deliverMemoryEvent,
  enqueueMemoryEvent,
  leaseMemoryEvent,
  markMemoryEventFailed,
  validateOutboxDestination,
} from "../src/services/event-outbox.ts";
import { MetricRegistry } from "../src/utils/observability.ts";
import { redactLogContext, sanitizeLogMessage } from "../src/utils/logger.ts";
import { verifyProductionGate } from "../scripts/v4-gate-verify.ts";
import { buildRuntimeAcceptanceReport } from "../scripts/v4-runtime-acceptance.ts";

const roots: string[] = [];
const MIGRATIONS = path.resolve(import.meta.dir, "..", "migrations");

function fixtureDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-p08-security-"));
  roots.push(root);
  const db = new Database(path.join(root, "fixture.db"), { create: true });
  configureWritableDatabase(db);
  applyMigrationsToDatabase(db, { migrationsDir: MIGRATIONS, targetVersion: 32 });
  db.query("INSERT INTO workspaces (id,name,slug) VALUES ('ws-security','Security','security')").run();
  return db;
}

afterEach(() => {
  delete process.env.QOOPIA_V4_EVENT_OUTBOX;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("P08 security and observability", () => {
  test("outbox is default OFF, metadata-only, idempotent, and signed", async () => {
    const db = fixtureDb();
    expect(() => enqueueMemoryEvent({
      workspace_id: "ws-security", event_type: "feedback_recorded", aggregate_kind: "note",
      aggregate_id: "note-1", payload: { note_id: "note-1" }, idempotency_key: "outbox-off-key", database: db,
    })).toThrow(/disabled/);
    process.env.QOOPIA_V4_EVENT_OUTBOX = "true";
    expect(() => enqueueMemoryEvent({
      workspace_id: "ws-security", event_type: "feedback_recorded", aggregate_kind: "note",
      aggregate_id: "note-1", payload: { body: "must not leave" }, idempotency_key: "outbox-body-key", database: db,
    })).toThrow(/metadata-only/);
    const first = enqueueMemoryEvent({
      workspace_id: "ws-security", event_type: "feedback_recorded", aggregate_kind: "note",
      aggregate_id: "note-1", payload: { note_id: "note-1", result: "helpful" }, idempotency_key: "outbox-good-key", database: db,
    });
    const replay = enqueueMemoryEvent({
      workspace_id: "ws-security", event_type: "feedback_recorded", aggregate_kind: "note",
      aggregate_id: "note-1", payload: { note_id: "note-1", result: "helpful" }, idempotency_key: "outbox-good-key", database: db,
    });
    expect(replay.id).toBe(first.id);
    expect(replay.reused).toBe(true);
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      const lease = leaseMemoryEvent({ workspace_id: "ws-security", destination_id: "audit", lease_owner: `worker-${attempt}`, database: db });
      if (attempt === 1) expect(lease).toBeNull();
      break;
    }
    const delivered = await deliverMemoryEvent({
      row: { id: first.id, event_type: "feedback_recorded", payload: JSON.stringify({ note_id: "note-1" }) },
      destination: { id: "audit", url: "https://events.example.test/v1", allowed_hosts: ["events.example.test"], signing_key: Buffer.alloc(32, 7) },
      resolver: async () => [{ address: "203.0.113.10" }],
      fetchImpl: (async (_url: URL | RequestInfo, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        expect((init?.headers as Record<string, string>)["x-qoopia-signature"]).toMatch(/^sha256=/);
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    expect(delivered.status).toBe(200);
    db.query("UPDATE memory_event_outbox SET destination_id='audit' WHERE id=?").run(first.id);
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      const owner = `worker-${attempt}`;
      const lease = leaseMemoryEvent({ workspace_id: "ws-security", destination_id: "audit", lease_owner: owner, database: db });
      expect(lease?.id).toBe(first.id);
      const state = markMemoryEventFailed({ workspace_id: "ws-security", id: first.id, lease_owner: owner, error_code: "OFFLINE", database: db });
      expect(state).toBe(attempt === OUTBOX_MAX_ATTEMPTS ? "dead_letter" : "failed");
      if (state === "failed") db.query("UPDATE memory_event_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?").run(first.id);
    }
    expect(leaseMemoryEvent({ workspace_id: "ws-security", destination_id: "audit", lease_owner: "extra", database: db })).toBeNull();
    db.close();
  });

  test("SSRF controls reject non-HTTPS, private, redirect, and DNS rebinding targets", async () => {
    const base = { id: "d", allowed_hosts: ["events.example.test"], signing_key: Buffer.alloc(32, 9) };
    await expect(validateOutboxDestination({ ...base, url: "http://events.example.test" }, async () => [{ address: "203.0.113.5" }])).rejects.toThrow(/HTTPS/);
    await expect(validateOutboxDestination({ ...base, url: "https://events.example.test" }, async () => [{ address: "127.0.0.1" }])).rejects.toThrow(/private/);
    await expect(validateOutboxDestination({ ...base, url: "https://events.example.test" }, async () => [{ address: "::ffff:10.0.0.1" }])).rejects.toThrow(/private/);
    await expect(validateOutboxDestination({ ...base, signing_key: Buffer.alloc(16), url: "https://events.example.test" }, async () => [{ address: "203.0.113.5" }])).rejects.toThrow(/32 bytes/);
    await expect(deliverMemoryEvent({
      row: { id: "event-redirect", event_type: "feedback_recorded", payload: "{}" },
      destination: { ...base, url: "https://events.example.test" },
      resolver: async () => [{ address: "203.0.113.5" }],
      fetchImpl: (async () => new Response(null, { status: 302 })) as typeof fetch,
    })).rejects.toThrow(/redirect/);
  });

  test("logs redact secret-shaped values and metrics refuse identifier labels", () => {
    expect(redactLogContext({ token: "never-log", nested: { authorization: "Bearer value" } })).toEqual({
      token: "[REDACTED]", nested: { authorization: "[REDACTED]" },
    });
    expect(sanitizeLogMessage("query=private words url=https://example.test/?code=opaque")).toBe(
      "query=[REDACTED] words url=https://example.test/?code=[REDACTED]",
    );
    const metrics = new MetricRegistry(2);
    metrics.observe("v4_recall_latency_ms", 4, { mode: "hybrid", result: "ok" });
    expect(metrics.snapshot()[0]?.count).toBe(1);
    expect(() => metrics.increment("v4_bad_total", { workspace_id: "ws" })).toThrow(/high-cardinality/);
  });

  test("production gate requires exact owner/reviewer/backup bindings", () => {
    const now = new Date("2026-07-17T09:00:00Z");
    const releaseSha = "b".repeat(40);
    const input = {
      go: { owner: "Асхат", channel: "owner-own-channel", scope: "qoopia-v4-production", action: "deploy_restart", release_sha: releaseSha, go: true, message_id: "owner-message", issued_at: "2026-07-17T08:50:00Z", expires_at: "2026-07-17T09:10:00Z" },
      review: { verdict: "PASS", provider: "claude", model: "claude-fable-5", reviewed_sha: releaseSha },
      backup: { integrity_check: "ok", mode: "0600", sha256: "a".repeat(64), created_at: "2026-07-17T08:50:00Z" },
      action: "deploy_restart", release_sha: releaseSha, max_backup_age_minutes: 30, now,
    };
    expect(verifyProductionGate(input).valid).toBe(true);
    expect(verifyProductionGate({
      ...input,
      action: "backup",
      go: { ...input.go, action: "backup" },
      backup: undefined,
    }).valid).toBe(true);
    expect(() => verifyProductionGate({ ...input, action: "migration" })).toThrow(/owner GO/);
    expect(() => verifyProductionGate({ ...input, review: { ...input.review, model: "gpt-5.6-sol" } })).toThrow(/fable/);
    expect(() => verifyProductionGate({ ...input, go: { ...input.go, issued_at: "invalid" } })).toThrow(/owner GO/);
    expect(() => verifyProductionGate({ ...input, backup: { ...input.backup, created_at: "invalid" } })).toThrow(/backup/);
  });

  test("runtime harness requires live canonical agent resolution and performs no action", () => {
    const releaseSha = "c".repeat(40);
    const report = buildRuntimeAcceptanceReport({
      ring: 0,
      release_sha: releaseSha,
      live_agent_manifest: { source: "canonical_entity_search", resolved_at: "2026-07-17T09:00:00Z", agents: [{ id: "agent-ulid", slug: "agent-slug" }] },
      now: new Date("2026-07-17T09:05:00Z"),
    });
    expect(report.production_actions).toBe(false);
    expect(report.status).toBe("offline_harness_ready");
    expect(() => buildRuntimeAcceptanceReport({ ring: 0, release_sha: releaseSha, live_agent_manifest: { agents: [] } })).toThrow(/canonical/);
    expect(() => buildRuntimeAcceptanceReport({
      ring: 0, release_sha: releaseSha,
      live_agent_manifest: { source: "canonical_entity_search", resolved_at: "2026-07-17T08:00:00Z", agents: [{ id: "a", slug: "s" }] },
      now: new Date("2026-07-17T09:05:00Z"),
    })).toThrow(/stale/);
  });
});
