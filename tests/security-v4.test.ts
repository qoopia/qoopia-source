import { describe, expect, test } from "bun:test";
import { deliverMemoryEvent, validateOutboxDestination } from "../src/services/event-outbox.ts";
import { MetricRegistry } from "../src/utils/observability.ts";
import { redactLogContext, sanitizeLogMessage } from "../src/utils/logger.ts";
import { verifyProductionGate } from "../scripts/v4-gate-verify.ts";
import { buildRuntimeAcceptanceReport } from "../scripts/v4-runtime-acceptance.ts";
import { fakeFetch } from "./helpers/fake-fetch.ts";

describe("P08 security and observability", () => {
  test("outbox delivery is metadata-only and signed", async () => {
    const destination = { id: "audit", url: "https://events.example.test/v1", allowed_hosts: ["events.example.test"], signing_key: Buffer.alloc(32, 7) };
    const resolver = async () => [{ address: "203.0.113.10" }];
    await expect(deliverMemoryEvent({
      row: { id: "event-body", event_type: "feedback_recorded", payload: JSON.stringify({ body: "must not leave" }) },
      destination, resolver, fetchImpl: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    })).rejects.toThrow(/metadata-only/);
    const delivered = await deliverMemoryEvent({
      row: { id: "event-1", event_type: "feedback_recorded", payload: JSON.stringify({ note_id: "note-1" }) },
      destination, resolver,
      fetchImpl: fakeFetch(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        expect((init?.headers as Record<string, string> | undefined)?.["x-qoopia-signature"]).toMatch(/^sha256=/);
        return new Response("ok", { status: 200 });
      }),
    });
    expect(delivered.status).toBe(200);
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
      fetchImpl: fakeFetch(async () => new Response(null, { status: 302 })),
    })).rejects.toThrow(/redirect/);
  });

  test("SSRF private-address classifier covers every special-purpose range", async () => {
    const base = { id: "d", allowed_hosts: ["events.example.test"], signing_key: Buffer.alloc(32, 9), url: "https://events.example.test" };
    const verdict = async (address: string) =>
      validateOutboxDestination(base, async () => [{ address }]).then(() => "allowed", () => "blocked");
    const mustBlock = [
      "127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "0.0.0.0",
      "100.64.0.1", "100.100.100.100", "198.18.0.1", "192.0.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "fd00::1", "fe80::1", "fec0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
      "::ffff:a9fe:a9fe", "::FFFF:7F00:1", "::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "fe80::1%eth0",
    ];
    const leaks: string[] = [];
    for (const address of mustBlock) if (await verdict(address) === "allowed") leaks.push(address);
    expect(leaks).toEqual([]);
    for (const address of ["203.0.113.5", "93.184.216.34", "8.8.8.8", "::ffff:8.8.8.8", "2606:4700::1"]) {
      expect(await verdict(address)).toBe("allowed");
    }
    await expect(validateOutboxDestination({ ...base, allowed_hosts: ["[::1]"], url: "https://[::1]/" }, async () => [{ address: "203.0.113.5" }]))
      .rejects.toThrow(/private/);
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
