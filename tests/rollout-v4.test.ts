import { describe, expect, test } from "bun:test";
import {
  ACCEPTED_P09_SHA,
  verifyOfflineRing,
  V4_FLAGS,
} from "../scripts/v4-rollout-gate.ts";

const candidate = "a".repeat(40);
const allOff = Object.fromEntries(
  V4_FLAGS.map((flag) => [flag, false]),
) as Record<(typeof V4_FLAGS)[number], boolean>;
const common = {
  candidate_sha: candidate,
  accepted_base_sha: ACCEPTED_P09_SHA,
  production_actions: false as const,
  image: {
    id: `sha256:${"c".repeat(64)}`,
    revision: candidate,
    build_network: "none" as const,
    source_tree_clean: true as const,
  },
  database: {
    source: "isolated_production_size_clone" as const,
    source_snapshot_sha256: "d".repeat(64),
    schema_version: 32 as const,
    integrity_check: "ok" as const,
    foreign_key_violations: 0 as const,
    legacy_expected: 943 as const,
    legacy_covered: 943 as const,
    legacy_missing: 0 as const,
    bodies_in_evidence: false as const,
  },
  flags: allOff,
};

function ring0() {
  return {
    ...common,
    ring: 0 as const,
    isolation: {
      container_network: "none" as const,
      production_mounts: false as const,
      external_egress: false as const,
    },
    qualification: {
      typecheck: "pass" as const,
      full_tests: "pass" as const,
      migration_first_run: "pass" as const,
      migration_repeat_noop: "pass" as const,
      backfill_first_run: "pass" as const,
      backfill_repeat_noop: "pass" as const,
      v3_contract: "pass" as const,
      flags_off_gate: "pass" as const,
      flags_on_holdout_gate: "pass" as const,
      restore_rehearsal: "pass" as const,
      restore_rto_ms: 25,
    },
  };
}

describe("P10 offline rollout gates", () => {
  test("Ring 0 accepts only complete network-none qualification evidence", () => {
    const evidence = ring0();
    expect(verifyOfflineRing(evidence).pass).toBe(true);
    expect(() => verifyOfflineRing({
      ...evidence,
      database: { ...evidence.database, legacy_missing: 1 as never },
    })).toThrow(/943\/943/);
    expect(() => verifyOfflineRing({
      ...evidence,
      image: { ...evidence.image, revision: ACCEPTED_P09_SHA },
    })).toThrow(/image/);
    expect(() => verifyOfflineRing({
      ...evidence,
      qualification: { ...evidence.qualification, migration_repeat_noop: "fail" as never },
    })).toThrow(/qualification/);
    expect(() => verifyOfflineRing({
      ...evidence,
      qualification: { ...evidence.qualification, restore_rto_ms: 1_800_001 },
    })).toThrow(/RTO/);
  });

  test("candidate lineage, LATEST_ONLY dependency, and outbox fail closed", () => {
    const evidence = ring0();
    expect(() => verifyOfflineRing({
      ...evidence,
      accepted_base_sha: "b".repeat(40),
    })).toThrow(/accepted P09/);
    expect(() => verifyOfflineRing({
      ...evidence,
      flags: { ...allOff, QOOPIA_V4_LATEST_ONLY: true },
    })).toThrow(/LATEST_ONLY/);
    expect(() => verifyOfflineRing({
      ...evidence,
      flags: { ...allOff, QOOPIA_V4_EVENT_OUTBOX: true },
    })).toThrow(/outbox/);
  });

  test("Ring 1 requires a sealed no-egress all-flags-off shadow", () => {
    const evidence = {
      ...common,
      ring: 1 as const,
      isolation: {
        container_network: "none" as const,
        production_mounts: false as const,
        host_port_published: false as const,
        outbound_wake: false as const,
        outbound_webhooks: false as const,
      },
      shadow: {
        instance_id: "v4-ring1-shadow-offline",
        port: 13738,
        health_status: "ok" as const,
        health_release_sha: candidate,
        server_role: "canonical" as const,
        writes_enabled: true as const,
        v3_contract: "pass" as const,
      },
    };
    expect(verifyOfflineRing(evidence).next_gate).toMatch(/^STOP before Ring 2/);
    expect(() => verifyOfflineRing({
      ...evidence,
      shadow: { ...evidence.shadow, port: 3738 },
    })).toThrow(/shadow/);
    expect(() => verifyOfflineRing({
      ...evidence,
      isolation: { ...evidence.isolation, outbound_wake: true as never },
    })).toThrow(/wake/);
    expect(() => verifyOfflineRing({
      ...evidence,
      flags: { ...allOff, QOOPIA_V4_RELATIONS: true },
    })).toThrow(/flags OFF/);
  });
});
