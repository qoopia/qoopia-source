import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  assertRecoveryExecutionTarget,
  SANCTIONED_RECOVERY_GUEST,
  type RecoveryExecutionIdentity,
} from "../scripts/p3-qualification-materializer.ts";

const driver = join(import.meta.dir, "..", "scripts", "p3-qualification-materializer.ts");
const targets = new Set<string>();
const hostIdentity: RecoveryExecutionIdentity = {
  platform: process.platform,
  arch: process.arch,
  uid: process.getuid?.(),
  platform_uuid: "actual-host-is-not-the-sanctioned-guest",
};

afterEach(() => {
  for (const target of targets) expect(existsSync(target)).toBe(false);
  targets.clear();
});

function refused(args: string[], message: string) {
  const target = `/private/tmp/qoopia-p3-recovery-scale-guard-${process.pid}-${targets.size}`;
  targets.add(target);
  expect(existsSync(target)).toBe(false);
  const result = spawnSync(process.execPath, [driver, "--recovery-scale", ...args, "--target", target], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", P3_HOSTNAME: "qualifiers-Virtual-Machine.local" },
  });
  expect(result.status).not.toBe(0);
  expect(`${result.stderr}${result.stdout}`).toContain(message);
  expect(existsSync(target)).toBe(false);
}

describe("recovery scale target guard", () => {
  test("missing and unknown execution modes refuse before target creation", () => {
    refused(["--measurement-bytes", String(256 * 1024 ** 2), "--allow-streaming-measurement"], "REFUSED_EXECUTION_MODE_REQUIRED");
    refused(["--execution-mode", "looks-like-a-guest", "--measurement-bytes", String(256 * 1024 ** 2), "--allow-streaming-measurement"], "REFUSED_EXECUTION_MODE");
  });

  test("unsupported bytes refuse before target creation", () => {
    refused(["--execution-mode", "sanctioned-guest-scale", "--measurement-bytes", String(64 * 1024 ** 2), "--allow-streaming-measurement"], "REFUSED_MEASUREMENT_BYTES");
    expect(() => assertRecoveryExecutionTarget("sanctioned-guest-scale", 2 * 1024 ** 3, hostIdentity)).toThrow("REFUSED_SCALE_BYTES");
  });

  test("actual host refuses every scale workload before target creation", () => {
    for (const bytes of [256 * 1024 ** 2, 1024 ** 3]) {
      refused(["--execution-mode", "sanctioned-guest-scale", "--measurement-bytes", String(bytes), "--allow-streaming-measurement"], "REFUSED_SANCTIONED_GUEST_IDENTITY");
    }
    refused(["--execution-mode", "sanctioned-guest-scale"], "REFUSED_SANCTIONED_GUEST_IDENTITY");
  });

  test("missing or wrong canonical identity refuses and env hostname cannot substitute", () => {
    expect(() => assertRecoveryExecutionTarget("sanctioned-guest-scale", 256 * 1024 ** 2, undefined)).toThrow("REFUSED_SANCTIONED_GUEST_IDENTITY_MISSING");
    expect(() => assertRecoveryExecutionTarget("sanctioned-guest-scale", 256 * 1024 ** 2, hostIdentity)).toThrow("REFUSED_SANCTIONED_GUEST_IDENTITY");
  });

  test("pinned guest identity decision and local small mode are pure", () => {
    expect(assertRecoveryExecutionTarget("sanctioned-guest-scale", 256 * 1024 ** 2, SANCTIONED_RECOVERY_GUEST)).toEqual("sanctioned-guest-scale");
    expect(assertRecoveryExecutionTarget("sanctioned-guest-scale", 1024 ** 3, SANCTIONED_RECOVERY_GUEST)).toEqual("sanctioned-guest-scale");
    expect(assertRecoveryExecutionTarget("sanctioned-guest-scale", 5 * 1024 ** 3, SANCTIONED_RECOVERY_GUEST)).toEqual("sanctioned-guest-scale");
    expect(assertRecoveryExecutionTarget("local-small-selfcheck", 8 * 1024 ** 2, undefined)).toEqual("local-small-selfcheck");
    expect(() => assertRecoveryExecutionTarget("local-small-selfcheck", 256 * 1024 ** 2, undefined)).toThrow("REFUSED_LOCAL_MODE_FOR_SCALE");
  });
});
