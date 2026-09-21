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

    expect(dockerfile).toContain("RUN touch /tmp/qoopia-verify-passed");
    expect(dockerfile).toContain(
      "COPY --from=verify /tmp/qoopia-verify-passed /tmp/qoopia-verify-passed",
    );
    expect(buildScript).toMatch(
      /\["build", "--target", "verify", "\.", \.\.\.contextArgs\]/,
    );
    expect(buildScript).toMatch(/"--target",\s*"runtime"/);
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
  });

  test("CLI and installer cannot auto-apply schema", () => {
    const cli = read("src/cli.ts");
    const installer = read("src/admin/install.ts");
    const importer = read("scripts/migrate-from-v2.ts");

    expect(cli).not.toContain("runMigrations");
    expect(cli).toContain("assertSchemaCurrent");
    expect(installer).not.toContain("runMigrations");
    expect(installer).toContain("getPendingMigrations");
    expect(importer).not.toContain("runMigrations");
    expect(importer).toContain("assertSchemaCurrent");
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
