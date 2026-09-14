import fs from "node:fs";
import path from "node:path";

const SHA_RE = /^[0-9a-f]{40}$/;
const IMAGE_RE = /^sha256:[0-9a-f]{64}$/;
export const ACCEPTED_P09_SHA = "0608c1c08f8109fe8ee3d52e3b94300e019ebdd0";

export const V4_FLAGS = [
  "QOOPIA_V4_RELATIONS",
  "QOOPIA_V4_LATEST_ONLY",
  "QOOPIA_V4_RECALL_EXPLAIN",
  "QOOPIA_V4_LIFECYCLE",
  "QOOPIA_V4_EXTRACTION",
  "QOOPIA_V4_FEEDBACK",
  "QOOPIA_V4_EVENT_OUTBOX",
  "QOOPIA_V4_DASHBOARD",
] as const;

type V4Flag = (typeof V4_FLAGS)[number];
type FlagState = Record<V4Flag, boolean>;

interface CommonEvidence {
  ring: 0 | 1;
  candidate_sha: string;
  accepted_base_sha: string;
  production_actions: false;
  image: {
    id: string;
    revision: string;
    build_network: "none";
    source_tree_clean: true;
  };
  database: {
    source: "isolated_production_size_clone";
    source_snapshot_sha256: string;
    schema_version: 32;
    integrity_check: "ok";
    foreign_key_violations: 0;
    legacy_expected: 943;
    legacy_covered: 943;
    legacy_missing: 0;
    bodies_in_evidence: false;
  };
  flags: FlagState;
}

interface Ring0Evidence extends CommonEvidence {
  ring: 0;
  isolation: {
    container_network: "none";
    production_mounts: false;
    external_egress: false;
  };
  qualification: {
    typecheck: "pass";
    full_tests: "pass";
    migration_first_run: "pass";
    migration_repeat_noop: "pass";
    backfill_first_run: "pass";
    backfill_repeat_noop: "pass";
    v3_contract: "pass";
    flags_off_gate: "pass";
    flags_on_holdout_gate: "pass";
    restore_rehearsal: "pass";
    restore_rto_ms: number;
  };
}

interface Ring1Evidence extends CommonEvidence {
  ring: 1;
  isolation: {
    container_network: "none";
    production_mounts: false;
    host_port_published: false;
    outbound_wake: false;
    outbound_webhooks: false;
  };
  shadow: {
    instance_id: string;
    port: number;
    health_status: "ok";
    health_release_sha: string;
    server_role: "canonical";
    writes_enabled: true;
    v3_contract: "pass";
  };
}

export type OfflineRingEvidence = Ring0Evidence | Ring1Evidence;

function fail(message: string): never {
  throw new Error(`P10 offline ring gate: ${message}`);
}

function assertCommon(input: OfflineRingEvidence): void {
  if (!SHA_RE.test(input.candidate_sha) || input.accepted_base_sha !== ACCEPTED_P09_SHA ||
      input.candidate_sha === input.accepted_base_sha) {
    fail("exact candidate and accepted P09 base SHAs are required");
  }
  if (input.production_actions !== false) fail("production actions are forbidden in Rings 0 and 1");
  if (!IMAGE_RE.test(input.image.id) || input.image.revision !== input.candidate_sha ||
      input.image.build_network !== "none" || input.image.source_tree_clean !== true) {
    fail("immutable offline image evidence is invalid");
  }
  const db = input.database;
  if (db.source !== "isolated_production_size_clone" ||
      !/^[0-9a-f]{64}$/.test(db.source_snapshot_sha256) ||
      db.schema_version !== 32 || db.integrity_check !== "ok" ||
      db.foreign_key_violations !== 0 || db.legacy_expected !== 943 ||
      db.legacy_covered !== 943 || db.legacy_missing !== 0 ||
      db.bodies_in_evidence !== false) {
    fail("clone integrity, schema, privacy, or 943/943 coverage evidence is invalid");
  }
  for (const flag of V4_FLAGS) {
    if (typeof input.flags[flag] !== "boolean") fail(`missing boolean flag ${flag}`);
  }
  if (input.flags.QOOPIA_V4_LATEST_ONLY && !input.flags.QOOPIA_V4_RELATIONS) {
    fail("LATEST_ONLY requires RELATIONS");
  }
  if (input.flags.QOOPIA_V4_EVENT_OUTBOX) fail("external event outbox must remain OFF in Rings 0 and 1");
}

export function verifyOfflineRing(input: OfflineRingEvidence): {
  pass: true;
  ring: 0 | 1;
  candidate_sha: string;
  production_actions: false;
  next_gate: string;
} {
  assertCommon(input);
  if (input.ring === 0) {
    if (input.isolation.container_network !== "none" ||
        input.isolation.production_mounts !== false ||
        input.isolation.external_egress !== false) {
      fail("Ring 0 must be network-none with no production mounts or egress");
    }
    const q = input.qualification;
    if (q.typecheck !== "pass" || q.full_tests !== "pass" ||
        q.migration_first_run !== "pass" || q.migration_repeat_noop !== "pass" ||
        q.backfill_first_run !== "pass" || q.backfill_repeat_noop !== "pass" ||
        q.v3_contract !== "pass" || q.flags_off_gate !== "pass" ||
        q.flags_on_holdout_gate !== "pass" || q.restore_rehearsal !== "pass" ||
        !Number.isFinite(q.restore_rto_ms) || q.restore_rto_ms < 0 ||
        q.restore_rto_ms > 30 * 60_000) {
      fail("Ring 0 qualification or restore RTO evidence is invalid");
    }
    return {
      pass: true,
      ring: 0,
      candidate_sha: input.candidate_sha,
      production_actions: false,
      next_gate: "Ring 1 sealed shadow on the isolated clone",
    };
  }
  if (input.isolation.container_network !== "none" ||
      input.isolation.production_mounts !== false ||
      input.isolation.host_port_published !== false ||
      input.isolation.outbound_wake !== false ||
      input.isolation.outbound_webhooks !== false) {
    fail("Ring 1 shadow must have no production mount, host port, wake, webhook, or network egress");
  }
  if (V4_FLAGS.some((flag) => input.flags[flag])) {
    fail("Ring 1 startup compatibility proof requires all V4 flags OFF");
  }
  const shadow = input.shadow;
  if (!shadow.instance_id.startsWith("v4-ring1-shadow-") ||
      !Number.isInteger(shadow.port) || shadow.port <= 0 ||
      shadow.port > 65_535 || shadow.port === 3738 ||
      shadow.health_status !== "ok" ||
      shadow.health_release_sha !== input.candidate_sha ||
      shadow.server_role !== "canonical" || shadow.writes_enabled !== true ||
      shadow.v3_contract !== "pass") {
    fail("Ring 1 shadow identity, health, role, release, or V3 contract evidence is invalid");
  }
  return {
    pass: true,
    ring: 1,
    candidate_sha: input.candidate_sha,
    production_actions: false,
    next_gate: "STOP before Ring 2: action-specific production GO and fresh backup are absent",
  };
}

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function runRolloutGateCli(): void {
  const inputPath = valueAfter("--input");
  const reportPath = valueAfter("--report");
  if (!inputPath || !reportPath) {
    throw new Error("usage: v4-rollout-gate --input ring.json --report result.json");
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as OfflineRingEvidence;
  const result = verifyOfflineRing(input);
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) runRolloutGateCli();
