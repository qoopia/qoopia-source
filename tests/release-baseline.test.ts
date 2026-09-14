import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyReleaseBaseline } from "../src/utils/release-baseline.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const roots: string[] = [];

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-release-test-"));
  roots.push(root);
  return root;
}

function stamp(root: string, value: unknown): string {
  const stampPath = path.join(root, "release.json");
  fs.writeFileSync(stampPath, JSON.stringify(value));
  return stampPath;
}

function productionEnv(stampPath?: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    QOOPIA_RELEASE_STAMP_PATH: stampPath,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("release baseline guard", () => {
  test("refuses normal startup without a release stamp", () => {
    const root = scratch();
    expect(() =>
      verifyReleaseBaseline({ repoRoot: root, env: productionEnv() }),
    ).toThrow("QOOPIA_RELEASE_STAMP_PATH");
  });

  test("refuses a stamp that admits a dirty build", () => {
    const root = scratch();
    const stampPath = stamp(root, { commit_sha: SHA_A, dirty: true });
    expect(() =>
      verifyReleaseBaseline({ repoRoot: root, env: productionEnv(stampPath) }),
    ).toThrow("dirty=false");
  });

  test("accepts a stamped immutable image without a git checkout", () => {
    const root = scratch();
    const stampPath = stamp(root, { commit_sha: SHA_A, dirty: false });
    expect(
      verifyReleaseBaseline({ repoRoot: root, env: productionEnv(stampPath) }),
    ).toEqual({
      commitSha: SHA_A,
      mode: "immutable-release",
      sourceTreeVerified: false,
      stampPath,
    });
  });

  test("refuses an operator-expected commit that differs from the image stamp", () => {
    const root = scratch();
    const stampPath = stamp(root, { commit_sha: SHA_A, dirty: false });
    expect(() =>
      verifyReleaseBaseline({
        repoRoot: root,
        env: {
          ...productionEnv(stampPath),
          QOOPIA_EXPECTED_RELEASE_SHA: SHA_B,
        },
      }),
    ).toThrow("expected release commit");
  });

  test("accepts a clean checkout whose HEAD matches the stamp", () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, ".git"));
    const stampPath = stamp(root, { commit_sha: SHA_A, dirty: false });
    const runGit = (args: string[]) => ({
      status: 0,
      stdout: args[0] === "rev-parse" ? `${SHA_A}\n` : "",
      stderr: "",
    });
    expect(
      verifyReleaseBaseline({
        repoRoot: root,
        env: productionEnv(stampPath),
        runGit,
      }).mode,
    ).toBe("clean-checkout");
  });

  test("refuses a dirty checkout", () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, ".git"));
    const stampPath = stamp(root, { commit_sha: SHA_A, dirty: false });
    const runGit = (args: string[]) => ({
      status: 0,
      stdout: args[0] === "rev-parse" ? `${SHA_A}\n` : " M src/http.ts\n",
      stderr: "",
    });
    expect(() =>
      verifyReleaseBaseline({
        repoRoot: root,
        env: productionEnv(stampPath),
        runGit,
      }),
    ).toThrow("source checkout is dirty");
  });

  test("refuses a checkout whose HEAD differs from the stamp", () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, ".git"));
    const stampPath = stamp(root, { commit_sha: SHA_A, dirty: false });
    expect(() =>
      verifyReleaseBaseline({
        repoRoot: root,
        env: productionEnv(stampPath),
        runGit: () => ({ status: 0, stdout: `${SHA_B}\n`, stderr: "" }),
      }),
    ).toThrow("does not match checkout HEAD");
  });
});
