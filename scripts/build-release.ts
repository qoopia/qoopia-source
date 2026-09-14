import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] || ""} failed`);
  }
  return (result.stdout || "").trim();
}

function assertCleanCheckout(): void {
  const status = capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(
      "Release build refused: commit or remove every tracked/untracked change first",
    );
  }
}

assertCleanCheckout();
const commitSha = capture("git", ["rev-parse", "HEAD"]);
if (!COMMIT_SHA_RE.test(commitSha)) {
  throw new Error("Release build refused: HEAD is not a full commit SHA");
}

const tagIndex = process.argv.indexOf("--tag");
const requestedTag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;
const tag = requestedTag || `qoopia:${commitSha.slice(0, 12)}`;

// Tests compare the pinned old release with the upgrade. Supply Git history
// without copying operator Git configuration or worktree-specific alternates.
const history = mkdtempSync(join(tmpdir(), "qoopia-build-history-"));
try {
capture("git", ["bundle", "create", join(history, "history.bundle"), "HEAD"]);
const contextArgs = ["--build-context", `history=${history}`];

// Build the verification target explicitly so modern builders cannot prune it
// as unused. The runtime target also copies its success marker as a second,
// Dockerfile-level dependency.
const verifyBuild = spawnSync(
  "docker",
  ["build", "--target", "verify", ".", ...contextArgs],
  { stdio: "inherit" },
);
if (verifyBuild.status !== 0) {
  throw new Error("Release verification build failed");
}

const runtimeBuild = spawnSync(
  "docker",
  [
    "build",
    ...contextArgs,
    "--target",
    "runtime",
    "--build-arg",
    `QOOPIA_GIT_SHA=${commitSha}`,
    "--label",
    `org.opencontainers.image.revision=${commitSha}`,
    "--tag",
    tag,
    ".",
  ],
  { stdio: "inherit" },
);
if (runtimeBuild.status !== 0) {
  throw new Error("Release image build failed");
}

const imageId = capture("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
  throw new Error("Release image build produced no immutable sha256 image ID");
}

assertCleanCheckout();
console.log(JSON.stringify({
  image_tag: tag,
  image_ref: imageId,
  commit_sha: commitSha,
}));
} finally {
  rmSync(history, { recursive: true, force: true });
}
