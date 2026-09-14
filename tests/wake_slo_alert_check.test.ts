import { clearResolvedAlerts } from "../scripts/wake_slo_alert_check.ts";
/**
 * Tests for the Wake SLO P2 alert helper (Phase 2 Item H).
 *
 * Layered:
 *   1. Pure-function unit tests — computeStats, detectBreach, isMuted,
 *      buildPayload, summariseSampleHangs, id8.
 *   2. State-file I/O round-trip — readState/writeState/recordFire.
 *   3. Full synthetic-fixture run — insert probes into the test DB,
 *      invoke run(), assert exit code + emit outcome + side-effects.
 *
 * All DB work uses the bun-test preload (`tests/setup.ts`) which redirects
 * QOOPIA_DATA_DIR to a tmp dir. NO production DB mutation.
 *
 * R2 (Leo BLOCK 01KSCX524947SY0V3JMFGD8GN6): unset wake-push webhook envs
 * BEFORE the first import of any module that reads them at call-time.
 * Otherwise the per-test `agentSend` calls in the synthetic-fixture suite
 * would issue REAL HTTP POSTs to the production corsair-main bridge — that
 * is the flood the R1 cycle caused. `getWebhookConfig` returns null when
 * either env is missing, so the durable worker marks the optional delivery
 * acceleration ignored and no network call is made.
 */
for (const key of Object.keys(process.env)) {
  if (/^AGENTCOMM_.*_WEBHOOK_(URL|SECRET|TOKEN|AUTH)$/.test(key)) {
    delete process.env[key];
  }
}

import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";

import {
  computeStats,
  detectBreach,
  isMuted,
  buildPayload,
  summariseSampleHangs,
  id8,
  readState,
  writeState,
  recordFire,
  evaluate,
  run,
} from "../scripts/wake_slo_alert_check.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";
const NOW = "2026-05-24T12:00:00.000Z";
const HALF_HOUR_MS = 30 * 60 * 1000;

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Wake SLO alert", slug: "wake-slo-alert" });
  WORKSPACE_ID = ws.id;
  const a = createAgent({ name: "corsair-main", workspaceSlug: ws.slug });
  AGENT_ID = a.id;
});

/* ────────────────────────────  helpers  ──────────────────────────────── */

function tmpStateFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wake-alert-state-")), "state.json");
}

function clearProbes(): void {
  db.prepare("DELETE FROM wake_slo_probes").run();
}

function insertProbe(opts: {
  direction: "C2L" | "L2C";
  status: "ok" | "failed";
  error_class?: string | null;
  started_at?: string;
  session_id?: string;
}): void {
  const started_at = opts.started_at ?? NOW;
  db.prepare(
    `INSERT INTO wake_slo_probes
       (direction, started_at, wake_attempted, wake_ok, delivery_latency_ms,
        reply_latency_ms, status, error_class, session_id)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.direction,
    started_at,
    opts.status === "ok" ? 1 : 0,
    opts.status === "ok" ? 100 : null,
    opts.status === "ok" ? 200 : null,
    opts.status,
    opts.error_class ?? null,
    opts.session_id ?? null,
  );
}

function fakeRow(over: Partial<{
  probe_id: number;
  direction: "C2L" | "L2C";
  started_at: string;
  status: "ok" | "failed";
  error_class: string | null;
  session_id: string | null;
}> = {}) {
  return {
    probe_id: over.probe_id ?? 1,
    direction: over.direction ?? "C2L",
    started_at: over.started_at ?? NOW,
    status: over.status ?? "ok",
    error_class: over.error_class ?? null,
    session_id: over.session_id ?? null,
  };
}

/* ────────────────────────────  unit: stats  ──────────────────────────── */

describe("computeStats", () => {
  test("empty input → n=0, failure_rate=0, no hangs", () => {
    const s = computeStats([], "C2L");
    expect(s.n).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.failure_rate).toBe(0);
    expect(s.unexplained_hangs).toEqual([]);
  });

  test("single ok probe → 0% failure", () => {
    const s = computeStats([fakeRow({ status: "ok" })], "C2L");
    expect(s.n).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.failure_rate).toBe(0);
    expect(s.by_class.ok).toBe(1);
  });

  test("single failed probe → 100% failure", () => {
    const s = computeStats(
      [fakeRow({ status: "failed", error_class: "ack_timeout" })],
      "C2L",
    );
    expect(s.n).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.failure_rate).toBe(1);
    expect(s.by_class.ack_timeout).toBe(1);
  });

  test("mixed direction probes — only the asked direction counts", () => {
    const rows = [
      fakeRow({ direction: "C2L", status: "ok" }),
      fakeRow({ direction: "L2C", status: "failed", error_class: "reply_timeout" }),
      fakeRow({ direction: "C2L", status: "failed", error_class: "ack_timeout" }),
    ];
    const c2l = computeStats(rows, "C2L");
    expect(c2l.n).toBe(2);
    expect(c2l.failed).toBe(1);
    expect(c2l.failure_rate).toBe(0.5);
    const l2c = computeStats(rows, "L2C");
    expect(l2c.n).toBe(1);
    expect(l2c.failed).toBe(1);
    expect(l2c.failure_rate).toBe(1);
  });

  test("collects unexplained_hang rows separately", () => {
    const rows = [
      fakeRow({ status: "failed", error_class: "ack_timeout", probe_id: 1 }),
      fakeRow({ status: "failed", error_class: "unexplained_hang", probe_id: 2, session_id: "abc12345xyz" }),
    ];
    const s = computeStats(rows, "C2L");
    expect(s.unexplained_hangs.length).toBe(1);
    expect(s.unexplained_hangs[0].probe_id).toBe(2);
  });
});

/* ────────────────────────────  unit: thresholds  ─────────────────────── */

describe("detectBreach", () => {
  const THR_N = 30;
  const THR_RATE = 0.05;

  test("N<threshold and no hangs → no breach", () => {
    const stats = computeStats(
      Array.from({ length: 10 }, (_, i) =>
        fakeRow({
          probe_id: i,
          status: i < 9 ? "ok" : "failed",
          error_class: i < 9 ? null : "ack_timeout",
        }),
      ),
      "C2L",
    );
    expect(stats.n).toBe(10);
    expect(stats.failure_rate).toBe(0.1);
    expect(detectBreach(stats, THR_N, THR_RATE)).toBeNull();
  });

  test("N=threshold, rate exactly at threshold → no breach (strict >)", () => {
    // 30 rows, 0.05 → 1.5 failures; use 1 failure → 1/30 ≈ 0.033 ≤ 0.05.
    const stats = computeStats(
      Array.from({ length: 30 }, (_, i) =>
        fakeRow({
          probe_id: i,
          status: i === 0 ? "failed" : "ok",
          error_class: i === 0 ? "ack_timeout" : null,
        }),
      ),
      "C2L",
    );
    expect(stats.n).toBe(30);
    expect(stats.failure_rate).toBeLessThan(THR_RATE);
    expect(detectBreach(stats, THR_N, THR_RATE)).toBeNull();
  });

  test("N>threshold and rate>threshold → failure_rate_breach", () => {
    // 40 rows, 4 failures → 10% > 5%.
    const stats = computeStats(
      Array.from({ length: 40 }, (_, i) =>
        fakeRow({
          probe_id: i,
          status: i < 4 ? "failed" : "ok",
          error_class: i < 4 ? "ack_timeout" : null,
        }),
      ),
      "C2L",
    );
    expect(stats.failure_rate).toBe(0.1);
    const b = detectBreach(stats, THR_N, THR_RATE);
    expect(b).not.toBeNull();
    expect(b?.reason).toBe("failure_rate_breach");
  });

  test("any single unexplained_hang fires regardless of N", () => {
    const stats = computeStats(
      [fakeRow({ status: "failed", error_class: "unexplained_hang" })],
      "C2L",
    );
    expect(stats.n).toBe(1);
    const b = detectBreach(stats, THR_N, THR_RATE);
    expect(b).not.toBeNull();
    expect(b?.reason).toBe("unexplained_hang");
  });

  test("hang takes precedence over rate breach", () => {
    // Both gates would fire — hang should be reason.
    const rows = [
      ...Array.from({ length: 39 }, (_, i) =>
        fakeRow({ probe_id: i, status: i < 4 ? "failed" : "ok", error_class: i < 4 ? "ack_timeout" : null }),
      ),
      fakeRow({ probe_id: 99, status: "failed", error_class: "unexplained_hang" }),
    ];
    const stats = computeStats(rows, "C2L");
    expect(stats.failure_rate).toBeGreaterThan(0.05);
    expect(stats.unexplained_hangs.length).toBe(1);
    const b = detectBreach(stats, THR_N, THR_RATE);
    expect(b?.reason).toBe("unexplained_hang");
  });
});

/* ────────────────────────────  unit: mute  ───────────────────────────── */

describe("isMuted", () => {
  const breach = {
    direction: "C2L" as const,
    reason: "failure_rate_breach" as const,
    stats: computeStats([], "C2L"),
  };

  test("empty state → not muted", () => {
    expect(isMuted({}, breach, NOW, 4)).toBe(false);
  });

  test("recent same-reason same-direction fire within window → muted", () => {
    const lastIso = new Date(new Date(NOW).getTime() - 1 * 3_600_000).toISOString();
    expect(
      isMuted({ last_fire_by_key: { "failure_rate_breach:C2L": lastIso } }, breach, NOW, 4),
    ).toBe(true);
  });

  test("expired fire (older than window) → not muted", () => {
    const lastIso = new Date(new Date(NOW).getTime() - 5 * 3_600_000).toISOString();
    expect(
      isMuted({ last_fire_by_key: { "failure_rate_breach:C2L": lastIso } }, breach, NOW, 4),
    ).toBe(false);
  });

  test("different direction does NOT mute (separate key)", () => {
    const lastIso = new Date(new Date(NOW).getTime() - 1 * 3_600_000).toISOString();
    expect(
      isMuted({ last_fire_by_key: { "failure_rate_breach:L2C": lastIso } }, breach, NOW, 4),
    ).toBe(false);
  });

  test("different reason does NOT mute (separate key)", () => {
    const lastIso = new Date(new Date(NOW).getTime() - 1 * 3_600_000).toISOString();
    expect(
      isMuted({ last_fire_by_key: { "unexplained_hang:C2L": lastIso } }, breach, NOW, 4),
    ).toBe(false);
  });

  test("R1 legacy schema migrated on read → not muted (safe drop)", () => {
    // Simulate a state file written by R1 (single `last_fire` object).
    // readState should drop it; isMuted should return false so the next
    // breach in any tuple lands a fresh stamp under the keyed map.
    const f = path.join(os.tmpdir(), `legacy-state-${Date.now()}.json`);
    fs.writeFileSync(
      f,
      JSON.stringify({ last_fire: { iso: NOW, reason: "failure_rate_breach", direction: "C2L" } }),
    );
    const migrated = readState(f);
    expect(migrated.last_fire_by_key).toBeUndefined();
    expect(isMuted(migrated, breach, NOW, 4)).toBe(false);
  });
});

/* ────────────────────────────  unit: misc  ───────────────────────────── */

describe("id8", () => {
  test("nullish → em-dash", () => {
    expect(id8(null)).toBe("—");
    expect(id8(undefined)).toBe("—");
  });
  test("short string → as-is", () => {
    expect(id8("abc")).toBe("abc");
  });
  test("long string → first 8 chars only", () => {
    expect(id8("01KSCWJ42EQQXYS63T57PX9F4G")).toBe("01KSCWJ4");
  });
});

describe("summariseSampleHangs", () => {
  test("respects max=5 default", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      fakeRow({ probe_id: i, status: "failed", error_class: "unexplained_hang", session_id: `sess${i}aaa` }),
    );
    const summary = summariseSampleHangs(rows);
    expect(summary.length).toBe(5);
    expect(summary[0]).toMatchObject({ probe_id: 0, session_id8: "sess0aaa" });
  });
});

describe("buildPayload", () => {
  test("contains no probe body bytes — only counts + ids + class names", () => {
    const stats = computeStats(
      [
        fakeRow({ status: "failed", error_class: "unexplained_hang", probe_id: 1, session_id: "sssss12345" }),
      ],
      "C2L",
    );
    const breach = detectBreach(stats, 30, 0.05);
    expect(breach).not.toBeNull();
    const payload = buildPayload(breach!, {
      windowHours: 24,
      thresholdN: 30,
      thresholdRate: 0.05,
      nowIso: NOW,
    });
    const json = JSON.stringify(payload);
    // The probe never includes body bytes in the test fixture; ensure the
    // payload schema does not introduce any.
    expect(json).not.toContain("WAKE_SLO_PING");
    expect(json).not.toContain("WAKE_SLO_PONG");
    expect(payload.sample_hangs.length).toBe(1);
    expect(payload.sample_hangs[0].session_id8).toBe("sssss123");
  });
});

/* ────────────────────────────  state I/O  ────────────────────────────── */

describe("state file I/O", () => {
  test("missing file → empty state, no throw", () => {
    const f = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.json`);
    expect(readState(f)).toEqual({});
  });

  test("write → read round-trip preserves keyed map", () => {
    const f = tmpStateFile();
    const s = {
      last_fire_by_key: {
        "failure_rate_breach:C2L": NOW,
        "unexplained_hang:L2C": NOW,
      },
    };
    writeState(f, s);
    expect(readState(f)).toEqual(s);
  });

  test("write creates parent directory if missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-alert-parent-"));
    const f = path.join(dir, "nested/sub", "state.json");
    writeState(f, { last_fire_by_key: { "unexplained_hang:L2C": NOW } });
    expect(fs.existsSync(f)).toBe(true);
  });

  test("garbage file → empty state, no throw", () => {
    const f = path.join(os.tmpdir(), `garbage-${Date.now()}.json`);
    fs.writeFileSync(f, "{not-json");
    expect(readState(f)).toEqual({});
  });

  test("recordFire merges entries without clobbering other tuples", () => {
    // Regression for Leo R1 BLOCK 01KSCX524947SY0V3JMFGD8GN6:
    // a fire on tuple B must NOT erase tuple A's mute anchor.
    const f = tmpStateFile();
    const t0 = "2026-05-24T12:00:00.000Z";
    const t1 = "2026-05-24T12:01:00.000Z";

    const afterA = recordFire(f, "failure_rate_breach", "C2L", t0);
    expect(afterA.last_fire_by_key?.["failure_rate_breach:C2L"]).toBe(t0);

    const afterB = recordFire(f, "unexplained_hang", "L2C", t1);
    // Both keys must be present in the same map.
    expect(afterB.last_fire_by_key?.["failure_rate_breach:C2L"]).toBe(t0);
    expect(afterB.last_fire_by_key?.["unexplained_hang:L2C"]).toBe(t1);

    // Disk reflects both keys too (not just the in-memory return value).
    const reread = readState(f);
    expect(reread.last_fire_by_key?.["failure_rate_breach:C2L"]).toBe(t0);
    expect(reread.last_fire_by_key?.["unexplained_hang:L2C"]).toBe(t1);
  });

  test("recordFire on legacy state file drops the legacy key on first write", () => {
    const f = tmpStateFile();
    fs.writeFileSync(
      f,
      JSON.stringify({ last_fire: { iso: NOW, reason: "failure_rate_breach", direction: "C2L" } }),
    );
    const after = recordFire(f, "unexplained_hang", "L2C", NOW);
    expect(after.last_fire_by_key).toEqual({ "unexplained_hang:L2C": NOW });
    // The legacy `last_fire` field is gone from disk too.
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(raw.last_fire).toBeUndefined();
    expect(raw.last_fire_by_key).toEqual({ "unexplained_hang:L2C": NOW });
  });
});

/* ────────────────────────────  evaluate()  ───────────────────────────── */

describe("evaluate", () => {
  test("clean data per direction → zero breaches", () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      fakeRow({ direction: i % 2 === 0 ? "C2L" : "L2C", status: "ok", probe_id: i }),
    );
    const { breaches, stats } = evaluate(rows, {
      muteHours: 4,
      stateFile: "/tmp/x",
      windowHours: 24,
      thresholdN: 30,
      thresholdRate: 0.05,
      nowIso: NOW,
    });
    expect(breaches).toEqual([]);
    expect(stats.find((s) => s.direction === "C2L")?.n).toBe(30);
    expect(stats.find((s) => s.direction === "L2C")?.n).toBe(30);
  });

  test("C2L breach but L2C clean → one breach scoped to C2L", () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) =>
        fakeRow({ direction: "C2L", probe_id: i, status: i < 4 ? "failed" : "ok", error_class: i < 4 ? "ack_timeout" : null }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        fakeRow({ direction: "L2C", probe_id: 100 + i, status: "ok" }),
      ),
    ];
    const { breaches } = evaluate(rows, {
      muteHours: 4,
      stateFile: "/tmp/x",
      windowHours: 24,
      thresholdN: 30,
      thresholdRate: 0.05,
      nowIso: NOW,
    });
    expect(breaches.length).toBe(1);
    expect(breaches[0].direction).toBe("C2L");
    expect(breaches[0].reason).toBe("failure_rate_breach");
  });
});

/* ────────────────────────────  full run synthetic  ───────────────────── */

describe("run (synthetic fixture)", () => {
  test("clean DB → exit 2 (pre-check: not enough probes)", () => {
    clearProbes();
    const result = run({
      muteHours: 4,
      stateFile: tmpStateFile(),
      windowHours: 24,
      thresholdRate: 0.05,
      thresholdN: 30,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      selfAgentName: "corsair-main",
      nowIso: NOW,
    });
    expect(result.exit_code).toBe(2);
    expect(result.reason).toContain("pre-check");
  });

  test("clean data above threshold → exit 0 (no breach)", () => {
    clearProbes();
    for (let i = 0; i < 40; i++) {
      insertProbe({ direction: "C2L", status: "ok", started_at: new Date(new Date(NOW).getTime() - i * HALF_HOUR_MS).toISOString() });
      insertProbe({ direction: "L2C", status: "ok", started_at: new Date(new Date(NOW).getTime() - i * HALF_HOUR_MS).toISOString() });
    }
    const result = run({
      muteHours: 4,
      stateFile: tmpStateFile(),
      windowHours: 24,
      thresholdRate: 0.05,
      thresholdN: 30,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      selfAgentName: "corsair-main",
      nowIso: NOW,
    });
    expect(result.exit_code).toBe(0);
    expect(result.reason).toBe("clean");
  });

  test("failure_rate breach → exit 1; Sink A note + Sink B message both created", () => {
    clearProbes();
    // 40 C2L probes in last 12h, 5 failed = 12.5% > 5%, well over N=30.
    for (let i = 0; i < 40; i++) {
      const startedAt = new Date(new Date(NOW).getTime() - i * HALF_HOUR_MS).toISOString();
      insertProbe({
        direction: "C2L",
        status: i < 5 ? "failed" : "ok",
        error_class: i < 5 ? "ack_timeout" : null,
        started_at: startedAt,
        session_id: i < 5 ? `sess${i.toString().padStart(2, "0")}xxxxx` : undefined,
      });
    }

    const stateFile = tmpStateFile();
    const before = db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number };
    const beforeMsgs = db
      .prepare(`SELECT count(*) AS n FROM agent_comm_messages WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number };

    const result = run({
      muteHours: 4,
      stateFile,
      windowHours: 24,
      thresholdRate: 0.05,
      thresholdN: 30,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      selfAgentName: "corsair-main",
      nowIso: NOW,
    });

    expect(result.exit_code).toBe(1);
    expect(result.breach?.reason).toBe("failure_rate_breach");
    expect(result.breach?.direction).toBe("C2L");
    expect(result.emit?.note_id).toBeDefined();
    expect(result.emit?.message_id).toBeDefined();

    // Sink A: exactly one new note in the workspace.
    const afterNotes = db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number };
    expect(afterNotes.n).toBe(before.n + 1);

    // Sink A note content checks: no probe body bytes, no PING/PONG.
    const noteRow = db
      .prepare(`SELECT text, type, tags, metadata FROM notes WHERE id = ?`)
      .get(result.emit!.note_id) as { text: string; type: string; tags: string; metadata: string };
    expect(noteRow.type).toBe("context");
    expect(noteRow.text).not.toContain("WAKE_SLO_PING");
    expect(noteRow.text).not.toContain("WAKE_SLO_PONG");
    const tags = JSON.parse(noteRow.tags) as string[];
    expect(tags).toContain("phase-1-item-1");
    expect(tags).toContain("wake-slo");
    expect(tags).toContain("alert");
    expect(tags).toContain("P2");
    expect(tags).toContain("direction:C2L");

    // Sink B: a new AgentComm message addressed to corsair-main with the
    // self-alert topic prefix.
    const msgRow = db
      .prepare(`SELECT body, metadata FROM agent_comm_messages WHERE id = ?`)
      .get(result.emit!.message_id) as { body: string; metadata: string };
    expect(msgRow.body.startsWith("WAKE_SLO_P2_ALERT")).toBe(true);
    expect(msgRow.body).not.toContain("WAKE_SLO_PING");
    expect(msgRow.body).not.toContain("WAKE_SLO_PONG");

    const afterMsgs = db
      .prepare(`SELECT count(*) AS n FROM agent_comm_messages WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number };
    // run() may create an ack/wake-side message; we check there is at
    // least one new message and the agentSend itself returned an id that
    // exists in the table.
    expect(afterMsgs.n).toBeGreaterThan(beforeMsgs.n);

    // State file written with the breach's tuple key set to `nowIso`.
    const state = readState(stateFile);
    expect(state.last_fire_by_key?.["failure_rate_breach:C2L"]).toBe(NOW);
  });

  test("re-run within mute window → exit 0 muted, no new emit", () => {
    // Reuse the breach data from previous test setup pattern.
    clearProbes();
    for (let i = 0; i < 40; i++) {
      insertProbe({
        direction: "C2L",
        status: i < 5 ? "failed" : "ok",
        error_class: i < 5 ? "ack_timeout" : null,
        started_at: new Date(new Date(NOW).getTime() - i * HALF_HOUR_MS).toISOString(),
      });
    }
    const stateFile = tmpStateFile();

    const first = run({
      muteHours: 4, stateFile, windowHours: 24, thresholdRate: 0.05, thresholdN: 30,
      workspaceId: WORKSPACE_ID, agentId: AGENT_ID, selfAgentName: "corsair-main", nowIso: NOW,
    });
    expect(first.exit_code).toBe(1);

    const nowPlus2h = new Date(new Date(NOW).getTime() + 2 * 3_600_000).toISOString();
    const noteCountBeforeSecond = (db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number }).n;

    const second = run({
      muteHours: 4, stateFile, windowHours: 24, thresholdRate: 0.05, thresholdN: 30,
      workspaceId: WORKSPACE_ID, agentId: AGENT_ID, selfAgentName: "corsair-main", nowIso: nowPlus2h,
    });
    expect(second.exit_code).toBe(0);
    expect(second.muted).toBe(true);
    expect(second.emit).toBeUndefined();

    const noteCountAfter = (db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number }).n;
    expect(noteCountAfter).toBe(noteCountBeforeSecond);
  });

  test("unexplained_hang with small N still fires", () => {
    clearProbes();
    insertProbe({
      direction: "L2C",
      status: "failed",
      error_class: "unexplained_hang",
      session_id: "hang0001zzzz",
    });
    const result = run({
      muteHours: 4,
      stateFile: tmpStateFile(),
      windowHours: 24,
      thresholdRate: 0.05,
      thresholdN: 30,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      selfAgentName: "corsair-main",
      nowIso: NOW,
      dryRun: true,
    });
    expect(result.exit_code).toBe(1);
    expect(result.breach?.reason).toBe("unexplained_hang");
    expect(result.breach?.direction).toBe("L2C");
    expect(result.payload?.sample_hangs[0].session_id8).toBe("hang0001");
  });

  test("dry-run mode never touches Sink A/B", () => {
    clearProbes();
    for (let i = 0; i < 40; i++) {
      insertProbe({
        direction: "C2L",
        status: i < 5 ? "failed" : "ok",
        error_class: i < 5 ? "ack_timeout" : null,
        started_at: new Date(new Date(NOW).getTime() - i * HALF_HOUR_MS).toISOString(),
      });
    }
    const noteBefore = (db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number }).n;

    const result = run({
      muteHours: 4,
      stateFile: tmpStateFile(),
      windowHours: 24,
      thresholdRate: 0.05,
      thresholdN: 30,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      selfAgentName: "corsair-main",
      nowIso: NOW,
      dryRun: true,
    });
    expect(result.exit_code).toBe(1);
    expect(result.emit).toBeUndefined();
    expect(result.payload).toBeDefined();

    const noteAfter = (db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number }).n;
    expect(noteAfter).toBe(noteBefore);
  });

  test("tuple-scoped mute preserves active causes and re-fires a resolved cause", () => {
    // R2 regression for Leo R1 BLOCK 01KSCX524947SY0V3JMFGD8GN6.
    //
    // Sequence:
    //   T=0    fire A = (failure_rate_breach, C2L)
    //   T+1m   fire B = (unexplained_hang,    L2C) — must NOT overwrite A
    //   T+2m   re-evaluate A → muted (inside A's 4h window), zero new emit
    //   T+3m   B recurs after resolution at T+2m → new alert (P3 lifecycle)
    //
    // The R1 bug was that fire B's writeState clobbered last_fire so that
    // by T+2m, isMuted compared A against B's stamp/key and returned false,
    // re-firing A. After the per-tuple keyed-map fix both keys persist and
    // active A stays muted; P3 requires resolved B to notify on recurrence.
    clearProbes();
    const t0 = NOW;                                              // 12:00:00Z
    const t1 = new Date(new Date(t0).getTime() + 60_000).toISOString();   // 12:01:00Z
    const t2 = new Date(new Date(t0).getTime() + 120_000).toISOString();  // 12:02:00Z
    const t3 = new Date(new Date(t0).getTime() + 180_000).toISOString();  // 12:03:00Z
    const stateFile = tmpStateFile();
    const baseOpts = {
      muteHours: 4,
      stateFile,
      windowHours: 24,
      thresholdRate: 0.05,
      thresholdN: 30,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      selfAgentName: "corsair-main",
    };

    // Fixture A: 40 C2L probes, 5 failed → failure_rate_breach.
    for (let i = 0; i < 40; i++) {
      insertProbe({
        direction: "C2L",
        status: i < 5 ? "failed" : "ok",
        error_class: i < 5 ? "ack_timeout" : null,
        started_at: new Date(new Date(t0).getTime() - i * HALF_HOUR_MS).toISOString(),
      });
    }

    const fireA = run({ ...baseOpts, nowIso: t0 });
    expect(fireA.exit_code).toBe(1);
    expect(fireA.breach?.reason).toBe("failure_rate_breach");
    expect(fireA.breach?.direction).toBe("C2L");
    expect(readState(stateFile).last_fire_by_key?.["failure_rate_breach:C2L"]).toBe(t0);

    // Add one L2C unexplained_hang on top of A's fixture.
    insertProbe({
      direction: "L2C",
      status: "failed",
      error_class: "unexplained_hang",
      session_id: "hangzzz1zzzz",
      started_at: new Date(new Date(t1).getTime() - 60_000).toISOString(),
    });

    // First fire of B picks the highest-severity breach: the hang.
    const fireB = run({ ...baseOpts, nowIso: t1 });
    expect(fireB.exit_code).toBe(1);
    expect(fireB.breach?.reason).toBe("unexplained_hang");
    expect(fireB.breach?.direction).toBe("L2C");
    const stateAfterB = readState(stateFile);
    // ★ Core regression assertion: BOTH keys must be present after B.
    expect(stateAfterB.last_fire_by_key?.["failure_rate_breach:C2L"]).toBe(t0);
    expect(stateAfterB.last_fire_by_key?.["unexplained_hang:L2C"]).toBe(t1);

    const noteCountAfterAB = (db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number }).n;

    // T+2m: drop the hang fixture so the only candidate breach is A again.
    // (Hang outranks rate breach via the breaches.sort in run(); leaving it
    // in would test the wrong code path for "A still muted".)
    db.prepare(`DELETE FROM wake_slo_probes WHERE error_class = ?`).run("unexplained_hang");

    const reA = run({ ...baseOpts, nowIso: t2 });
    expect(reA.exit_code).toBe(0);
    expect(reA.muted).toBe(true);
    expect(reA.breach?.reason).toBe("failure_rate_breach");
    expect(reA.breach?.direction).toBe("C2L");
    expect(reA.emit).toBeUndefined();

    // T+3m: hang back in, A's rate-breach fixture still present; the hang
    // takes precedence again. P3: resolution cleared B suppression, so this is a new alert.
    insertProbe({
      direction: "L2C",
      status: "failed",
      error_class: "unexplained_hang",
      session_id: "hangzzz2zzzz",
      started_at: new Date(new Date(t3).getTime() - 60_000).toISOString(),
    });
    const reB = run({ ...baseOpts, nowIso: t3 });
    expect(reB.exit_code).toBe(1);
    expect(reB.muted).toBeUndefined();
    expect(reB.breach?.reason).toBe("unexplained_hang");
    expect(reB.breach?.direction).toBe("L2C");
    expect(reB.emit?.message_id).toBeDefined();

    // Exactly one new notification intent. Transport acceptance remains a separate gate.
    const noteCountFinal = (db
      .prepare(`SELECT count(*) AS n FROM notes WHERE workspace_id = ?`)
      .get(WORKSPACE_ID) as { n: number }).n;
    expect(noteCountFinal).toBe(noteCountAfterAB + 1);

    // Final state map still has both keys.
    const finalState = readState(stateFile);
    expect(finalState.last_fire_by_key?.["failure_rate_breach:C2L"]).toBe(t0);
    expect(finalState.last_fire_by_key?.["unexplained_hang:L2C"]).toBe(t3);
  });
});

test('P3 resolved alert clears suppression before a fresh recurrence; unrelated active cause stays suppressed',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p3-alert-'));const file=path.join(root,'state.json');
 try{recordFire(file,'failure_rate_breach','C2L','2026-09-05T00:00:00.000Z');recordFire(file,'unexplained_hang','L2C','2026-09-05T00:00:00.000Z');
 const state=clearResolvedAlerts(file,new Set(['unexplained_hang:L2C']));expect(state.last_fire_by_key?.['failure_rate_breach:C2L']).toBeUndefined();expect(state.last_fire_by_key?.['unexplained_hang:L2C']).toBeDefined();
 clearResolvedAlerts(file,new Set());expect(readState(file).last_fire_by_key).toEqual({});
 recordFire(file,'failure_rate_breach','C2L','2026-09-05T00:01:00.000Z');expect(readState(file).last_fire_by_key?.['failure_rate_breach:C2L']).toBe('2026-09-05T00:01:00.000Z');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
