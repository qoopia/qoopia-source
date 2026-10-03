import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("release artifact contracts", () => {
  test("active product markers identify the current stable release", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const http = read("src/http.ts");
    const cli = read("src/cli.ts");
    const installer = read("src/admin/install.ts");
    const mcpServer = read("src/mcp/server.ts");

    // The exact number belongs to product-version.test.ts, which pins package.json as its one
    // source of truth. Here it only has to be a stable 5.0 release, never a pre-release.
    expect(pkg.version).toMatch(/^5\.0\.\d+$/);
    for (const source of [http, cli, installer, mcpServer]) {
      expect(source).toContain("PRODUCT_VERSION");
      expect(source).not.toContain('version: "3.0.0"');
    }
  });

  test("release image cannot bypass the Docker verification stage", () => {
    const dockerfile = read("Dockerfile");
    const buildScript = read("scripts/build-release.ts");

    expect(dockerfile).toContain("RUN git rev-parse HEAD > /tmp/qoopia-verify-passed");
    expect(dockerfile).toContain(
      "COPY --from=verify /tmp/qoopia-verify-passed /tmp/qoopia-verify-passed",
    );
    expect(buildScript).toMatch(
      /\["build", "--target", "verify", "\.", \.\.\.contextArgs\]/,
    );
    expect(buildScript).toMatch(/"--target",\s*"runtime"/);
  });

  test("sign-in image cannot bypass its verification stage", () => {
    const identity = read("deploy/identity.Dockerfile");
    const verify = identity.split(/^FROM /m).find((stage) => stage.includes(" AS verify\n"))!;
    const runtime = identity.split(/^FROM /m).at(-1)!;
    expect(verify).toContain("RUN bun run typecheck");
    const tests = [...verify.matchAll(/tests\/[\w-]+\.test\.ts/g)].map((m) => m[0]);
    for (const file of ["tests/identity-login.test.ts", "tests/connection-consent.test.ts", "tests/brand-assets.test.ts"]) expect(tests).toContain(file);
    for (const file of tests) expect(fs.existsSync(path.join(repoRoot, file))).toBe(true);
    expect(verify).toMatch(/\nRUN [^\n]*\/tmp\/qoopia-verify-passed\n/);
    expect(runtime).toContain("COPY --from=verify /tmp/qoopia-verify-passed /tmp/qoopia-verify-passed");
  });

  test("sign-in image is stamped like the server image and built by the release script", () => {
    const identity = read("deploy/identity.Dockerfile");
    const stages = identity.split(/^FROM /m);
    const verify = stages.find((stage) => stage.includes(" AS verify\n"))!;
    const runtime = stages.at(-1)!;
    expect(runtime).toStartWith("${BUN_IMAGE} AS runtime\n");
    const clean = verify.indexOf('RUN test -z "$(git status --porcelain=v1 --untracked-files=all --ignored=matching -- src scripts package.json bun.lock)"');
    expect(clean).toBeGreaterThan(verify.indexOf("git reset --mixed FETCH_HEAD"));
    expect(clean).toBeLessThan(verify.indexOf("RUN bun run typecheck"));
    expect(verify).toContain("RUN git rev-parse HEAD > /tmp/qoopia-verify-passed");
    const marker = runtime.indexOf('RUN test "$(cat /tmp/qoopia-verify-passed)" = "${QOOPIA_GIT_SHA}"');
    expect(marker).toBeGreaterThan(runtime.indexOf("COPY --from=verify /tmp/qoopia-verify-passed"));
    expect(marker).toBeLessThan(runtime.indexOf('--sha "${QOOPIA_GIT_SHA}" --output /app/release.json'));
    expect(runtime).toContain("ENV QOOPIA_RELEASE_STAMP_PATH=/app/release.json");
    const buildScript = read("scripts/build-release.ts");
    expect(buildScript).toContain('identity ? "deploy/identity.Dockerfile" : "Dockerfile"');
    expect(buildScript).toMatch(/contextArgs = \["-f", dockerfile,/);
  });

  test("release images describe Qoopia, not the inherited Bun base", () => {
    for (const file of ["Dockerfile", "deploy/identity.Dockerfile"]) {
      const runtime = read(file).split(/^FROM /m).at(-1)!;
      for (const label of ["title", "description", "url", "documentation", "source", "vendor", "licenses"]) {
        expect(runtime).toMatch(new RegExp(`org\\.opencontainers\\.image\\.${label}="[^"$]+"`));
      }
      expect(runtime).toContain('org.opencontainers.image.version="${QOOPIA_VERSION}"');
      expect(runtime).toContain('org.opencontainers.image.created="${QOOPIA_CREATED}"');
      expect(runtime).toContain('org.opencontainers.image.revision="${QOOPIA_GIT_SHA}"');
    }
    const buildScript = read("scripts/build-release.ts");
    expect(buildScript).toContain("`QOOPIA_VERSION=${version}`");
    expect(buildScript).toContain("`QOOPIA_CREATED=${created}`");
  });

  test("release image holds exactly the stamped commit", () => {
    const dockerfile = read("Dockerfile");
    const [verify, runtime] = dockerfile.split("AS runtime") as [string, string];
    // Ignored files (.env, logs, local databases) under copied paths would ship
    // without showing in a plain git status.
    const clean = verify.indexOf('RUN test -z "$(git status --porcelain=v1 --untracked-files=all --ignored=matching -- src migrations scripts docs/v4 compose package.json bun.lock)"');
    expect(clean).toBeGreaterThan(verify.indexOf("git reset --mixed FETCH_HEAD"));
    expect(clean).toBeLessThan(verify.indexOf("RUN bun run typecheck"));
    const marker = runtime.indexOf('RUN test "$(cat /tmp/qoopia-verify-passed)" = "${QOOPIA_GIT_SHA}"');
    expect(marker).toBeGreaterThan(runtime.indexOf("COPY --from=verify /tmp/qoopia-verify-passed"));
    expect(marker).toBeLessThan(runtime.indexOf("RUN bun scripts/release-stamp.ts"));
    const ignore = read(".dockerignore").split("\n");
    for (const pattern of ["**/.env", "**/.env.*", "**/*.log", "**/.DS_Store"]) expect(ignore).toContain(pattern);
  });

  test("release images use one readable, digest-pinned base and record their OS packages", () => {
    const refs = ["Dockerfile", "deploy/identity.Dockerfile"].flatMap((file) =>
      [...read(file).matchAll(/^(?:FROM|ARG BUN_IMAGE=)\s*(\S+)/gm)].map((m) => m[1]!).filter((ref) => ref !== "${BUN_IMAGE}"),
    );
    expect(refs.length).toBe(2); // one ARG BUN_IMAGE per Dockerfile; every stage uses it
    for (const ref of refs) expect(ref).toMatch(/^oven\/bun:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    expect(new Set(refs).size).toBe(1);
    const runtime = read("Dockerfile").split("AS runtime")[1]!;
    // apt resolves by build date; the shipped OS package set is recorded, not assumed.
    expect(runtime).toMatch(/apt-get install[^\n]*\n[^\n]*dpkg-query -W[^\n]*> \/app\/os-packages\.txt/);
  });

  test("every release build path runs the supply-chain gates, not only CI", () => {
    const dockerfile = read("Dockerfile");
    const gate = dockerfile.indexOf("RUN bun audit && bun run sec:vendored-pdfjs");
    expect(gate).toBeGreaterThan(dockerfile.indexOf("COPY --chown=bun:bun . ."));
    expect(gate).toBeLessThan(dockerfile.indexOf("RUN git rev-parse HEAD > /tmp/qoopia-verify-passed"));
    expect(read("deploy/identity.Dockerfile")).toContain("RUN bun audit\n");
    const bundle = read("scripts/build-bundle.ts");
    expect(bundle).toContain("const pdfjs=checkVendoredPdfjs();");
    expect(bundle).toContain("spawnSync(process.execPath,['audit']");
  });

  test("release compose requires immutable inputs and one canonical root", () => {
    const compose = read("deploy/docker-compose.release.yml");

    expect(compose).toContain(
      "image: ${QOOPIA_IMAGE_REF:?set QOOPIA_IMAGE_REF to an immutable sha256 image reference}",
    );
    expect(compose).toContain(
      "QOOPIA_SERVER_ROLE: ${QOOPIA_SERVER_ROLE:?set QOOPIA_SERVER_ROLE explicitly}",
    );
    expect(compose).toContain("QOOPIA_ROOT: ${QOOPIA_ROOT}");
    expect(compose).toContain(
      "QOOPIA_PORT: ${QOOPIA_PORT:?set the canonical service port explicitly}",
    );
    expect(compose).toContain("QOOPIA_DATA_DIR: ${QOOPIA_ROOT}/data");
    expect(compose).toContain("QOOPIA_LOG_DIR: ${QOOPIA_ROOT}/logs");
    expect(compose).toContain("QOOPIA_BACKUP_DIR: ${QOOPIA_ROOT}/backups");
    expect(compose).toContain('QOOPIA_AUTO_MIGRATE: "false"');
    expect(compose).toContain("${QOOPIA_ROOT}/data:${QOOPIA_ROOT}/data");
    expect(compose).toContain(
      "body.server_role !== process.env.QOOPIA_SERVER_ROLE",
    );
    expect(compose).toContain("$${process.env.QOOPIA_PORT}/ready");
    expect(compose).not.toContain("$${process.env.QOOPIA_PORT}/health");
  });

  // scripts/v4-rollback-rehearsal.ts asserts that rolling back is an image
  // swap rather than a code-directory swap, and it reads compose/docker-
  // compose.v4.yml because that is the only compose baked into the image by
  // the Dockerfile. Production runs deploy/docker-compose.release.yml, which
  // the rehearsal cannot see, so the same property is asserted here instead
  // of trusting that the two files agree.
  test("no shipped compose can bind a mutable code directory into the container", () => {
    const composeFiles = [
      ...fs.readdirSync(path.join(repoRoot, "compose")).map((f) => `compose/${f}`),
      ...fs.readdirSync(path.join(repoRoot, "deploy")).map((f) => `deploy/${f}`),
    ].filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

    // A new compose file must be reviewed, not silently exempt from the check.
    expect(composeFiles.sort()).toEqual([
      "compose/docker-compose.v4.yml",
      "deploy/docker-compose.release.yml",
    ]);

    for (const file of composeFiles) {
      expect(read(file)).not.toContain("/srv/qoopia/code");
    }
  });

  test("normal startup has no environment-controlled migration bypass", () => {
    const index = read("src/index.ts");
    const releaseEntry = read("src/release-entry.ts");
    expect(index).not.toContain("runMigrations");
    expect(index).not.toContain("backupDbBeforeMigrate");
    expect(index).not.toContain("QOOPIA_AUTO_MIGRATE=true;");
    expect(index).toContain("Run `bun run db:integrity`");
    expect(releaseEntry.indexOf("validateRuntimeConfiguration(")).toBeLessThan(
      releaseEntry.indexOf("verifyReleaseBaseline({ env: releaseEnv });"),
    );
    expect(releaseEntry).toContain('NODE_ENV: "production"');
  });

  test("runtime image contains the reviewed one-shot operator commands", () => {
    const dockerfile = read("Dockerfile");
    for (const script of [
      "migrate.ts",
      "check-db-integrity.ts",
      "validate-runtime-config.ts",
      "v4-backup.ts",
      "v4-gate-verify.ts",
      "v4-runtime-acceptance.ts",
      "v4-rollout-gate.ts",
    ]) {
      expect(dockerfile).toContain(
        `COPY --from=verify /app/scripts/${script} ./scripts/${script}`,
      );
    }
    expect(dockerfile).toContain(
      "COPY --from=verify /app/compose/docker-compose.v4.yml ./compose/docker-compose.v4.yml",
    );
    // launchd plists serve only the macOS `install` command; the Linux image never reads them.
    expect(dockerfile.split("AS runtime")[1]).not.toMatch(/COPY[^\n]*templates/);
  });

  test("CLI and installer cannot auto-apply schema", () => {
    const cli = read("src/cli.ts");
    const installer = read("src/admin/install.ts");

    expect(cli).not.toContain("runMigrations");
    expect(cli).toContain("assertSchemaCurrent");
    expect(installer).not.toContain("runMigrations");
    expect(installer).toContain("getPendingMigrations");
  });

  test("documented package scripts reach a real entry point", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    // src/admin/install.ts only exports install(); running it directly did nothing.
    expect(scripts["install-service"]).toBe("bun run src/cli.ts install");
    expect(read("README.md")).toContain("QOOPIA_ADMIN_SECRET");
  });

  test("the explicit migration command preflights before backup and apply", () => {
    const migrate = read("scripts/migrate.ts");
    const preflight = migrate.indexOf("assertDatabaseIntegrity(");
    const backup = migrate.indexOf("backupDbBeforeMigrate(");
    const apply = migrate.indexOf("runMigrations();");

    expect(preflight).toBeGreaterThan(0);
    expect(backup).toBeGreaterThan(preflight);
    expect(apply).toBeGreaterThan(backup);
  });
});

// .github is excluded from the Docker build context, so the release image's verify stage
// has no workflows to read; CI and local checkouts still run these checks (F-337).
describe.skipIf(!fs.existsSync(path.join(repoRoot, ".github/workflows")))("CI workflows", () => {
  const workflow = (file: string) => Bun.YAML.parse(read(`.github/workflows/${file}`)) as any;
  const forkOnlyPullRequests = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository";
  // The public repository (qoopia-source, which carries SOURCE-MANIFEST.json) protects main with the
  // `typecheck + tests` check, and its pull requests come from forks: there the build job runs for every
  // pull request under that one name.
  const publicSource = fs.existsSync(path.join(repoRoot, "SOURCE-MANIFEST.json"));

  test("one CI run per commit: same-repo pull requests reuse the push run", () => {
    const ci = workflow("ci.yml");
    expect(ci.concurrency.group).toContain("${{ github.ref }}");
    expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/main' }}");
    if (publicSource) {
      expect(ci.jobs.build.if).toBe("github.event_name != 'schedule'");
      expect(ci.jobs.build.name).toBe("typecheck + tests");
      return;
    }
    expect(ci.jobs.build.if).toContain(forkOnlyPullRequests);
    // A skipped job reports success; a distinct name keeps it from standing in for the push check.
    expect(ci.jobs.build.name).toBe("${{ github.event_name == 'pull_request' && 'typecheck + tests (fork pull request)' || 'typecheck + tests' }}");
  });

  test("the live advisory feed is its own daily job and never hides test results", () => {
    const ci = workflow("ci.yml");
    const runs = (job: string) => ci.jobs[job].steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(runs("build")).not.toContain("bun audit");
    expect(runs("build")).not.toContain("sec:vendored-pdfjs");
    expect(runs("advisories")).toContain("bun audit");
    expect(runs("advisories")).toContain("bun run sec:vendored-pdfjs");
    expect(ci.jobs.advisories.if).toBe(forkOnlyPullRequests);
    expect(ci.on.schedule).toEqual([{ cron: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
    expect(ci.jobs.build.if).toStartWith("github.event_name != 'schedule'");
  });

  test("Linux bundle inputs come from the permanent Debian snapshot and are built daily", async () => {
    const { packages, sourceBase } = await import("../scripts/prepare-linux-support.ts");
    for (const url of [...packages.map((p) => p.url), sourceBase]) {
      expect(url).toMatch(/^https:\/\/snapshot\.debian\.org\/archive\/debian(-security)?\/\d{8}T\d{6}Z\/pool\//);
    }
    const job = workflow("ci.yml").jobs["linux-bundle"];
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(job.steps.map((step: { run?: string }) => step.run ?? "").join("\n"))
      .toContain('bun run bundle:build --test-fixture --out "$RUNNER_TEMP/qoopia-bundle"');
  });

  test("iOS runs only for iOS changes, never for tag pushes or duplicate pull requests", () => {
    const ios = workflow("ios.yml");
    expect(ios.on.push.branches).toEqual(["**"]);
    expect(ios.jobs.simulator.if).toBe(forkOnlyPullRequests);
    expect(ios.jobs.simulator.name).toContain("'simulator (fork pull request)'");
  });
});
