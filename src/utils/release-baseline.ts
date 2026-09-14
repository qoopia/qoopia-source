import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export interface ReleaseStamp {
  commit_sha: string;
  dirty: false;
}

export interface VerifiedReleaseBaseline {
  commitSha: string | null;
  mode: "immutable-release" | "clean-checkout" | "development-override";
  sourceTreeVerified: boolean;
  stampPath: string | null;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface VerifyOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  runGit?: (args: string[], cwd: string) => GitResult;
}

let verifiedBaseline: VerifiedReleaseBaseline | null = null;

function defaultRunGit(args: string[], cwd: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function readReleaseStamp(stampPath: string): ReleaseStamp {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Refusing to start: release stamp '${stampPath}' is unreadable or invalid JSON (${String(error)})`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("commit_sha" in parsed) ||
    typeof parsed.commit_sha !== "string" ||
    !COMMIT_SHA_RE.test(parsed.commit_sha) ||
    !("dirty" in parsed) ||
    parsed.dirty !== false
  ) {
    throw new Error(
      `Refusing to start: release stamp '${stampPath}' must contain a 40-character commit_sha and dirty=false`,
    );
  }
  return parsed as ReleaseStamp;
}

export function verifyReleaseBaseline(
  options: VerifyOptions = {},
): VerifiedReleaseBaseline {
  const runtimeEnv = options.env ?? process.env;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());

  if (
    runtimeEnv.NODE_ENV !== "production" &&
    runtimeEnv.QOOPIA_ALLOW_DIRTY_STARTUP === "true"
  ) {
    verifiedBaseline = {
      commitSha: null,
      mode: "development-override",
      sourceTreeVerified: false,
      stampPath: null,
    };
    return verifiedBaseline;
  }

  const configuredPath = runtimeEnv.QOOPIA_RELEASE_STAMP_PATH?.trim();
  if (!configuredPath) {
    throw new Error(
      "Refusing to start without QOOPIA_RELEASE_STAMP_PATH. Use `bun run dev` for an unsealed checkout or build a stamped release image.",
    );
  }
  const stampPath = resolve(repoRoot, configuredPath);
  const stamp = readReleaseStamp(stampPath);
  const expectedCommit = runtimeEnv.QOOPIA_EXPECTED_RELEASE_SHA?.trim();
  if (
    expectedCommit &&
    (!COMMIT_SHA_RE.test(expectedCommit) || expectedCommit !== stamp.commit_sha)
  ) {
    throw new Error(
      `Refusing to start: expected release commit '${expectedCommit}' does not match stamp ${stamp.commit_sha}`,
    );
  }

  if (!existsSync(resolve(repoRoot, ".git"))) {
    verifiedBaseline = {
      commitSha: stamp.commit_sha,
      mode: "immutable-release",
      sourceTreeVerified: false,
      stampPath,
    };
    return verifiedBaseline;
  }

  const runGit = options.runGit ?? defaultRunGit;
  const head = runGit(["rev-parse", "HEAD"], repoRoot);
  if (head.status !== 0 || !COMMIT_SHA_RE.test(head.stdout.trim())) {
    throw new Error(
      "Refusing to start: source checkout is present but its commit cannot be verified",
    );
  }
  if (head.stdout.trim() !== stamp.commit_sha) {
    throw new Error(
      `Refusing to start: release stamp commit ${stamp.commit_sha} does not match checkout HEAD ${head.stdout.trim()}`,
    );
  }

  const status = runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repoRoot,
  );
  if (status.status !== 0) {
    throw new Error(
      "Refusing to start: source checkout cleanliness cannot be verified",
    );
  }
  if (status.stdout.trim() !== "") {
    throw new Error(
      "Refusing to start: source checkout is dirty; build and run a committed release",
    );
  }

  verifiedBaseline = {
    commitSha: stamp.commit_sha,
    mode: "clean-checkout",
    sourceTreeVerified: true,
    stampPath,
  };
  return verifiedBaseline;
}

export function getVerifiedReleaseBaseline(): VerifiedReleaseBaseline | null {
  return verifiedBaseline;
}
