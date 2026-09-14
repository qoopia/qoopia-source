import os from "node:os";
import path from "node:path";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const IMMUTABLE_IMAGE_RE = /^(?:[a-z0-9._:/-]+@)?sha256:[0-9a-f]{64}$/i;

export interface RuntimePaths {
  rootDir: string;
  dataDir: string;
  logDir: string;
  backupDir: string;
}

export interface ReleaseInputs {
  imageRef: string;
  releaseSha: string;
  rootDir: string;
  serverRole: "canonical" | "legacy-readonly";
  port: number;
}

function normalizedAbsolute(value: string): string {
  return path.resolve(value.trim());
}

export function resolveRuntimePaths(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): RuntimePaths {
  const rootDir = normalizedAbsolute(
    runtimeEnv.QOOPIA_ROOT || path.join(homeDir, ".qoopia"),
  );
  return {
    rootDir,
    dataDir: normalizedAbsolute(
      runtimeEnv.QOOPIA_DATA_DIR || path.join(rootDir, "data"),
    ),
    logDir: normalizedAbsolute(
      runtimeEnv.QOOPIA_LOG_DIR || path.join(rootDir, "logs"),
    ),
    backupDir: normalizedAbsolute(
      runtimeEnv.QOOPIA_BACKUP_DIR || path.join(rootDir, "backups"),
    ),
  };
}

function assertAbsoluteEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): void {
  const value = runtimeEnv[name]?.trim();
  if (!value) {
    issues.push(`${name} is required`);
  } else if (!path.isAbsolute(value)) {
    issues.push(`${name} must be an absolute path`);
  }
}

function assertUrlEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): void {
  const value = runtimeEnv[name]?.trim();
  if (!value) {
    issues.push(`${name} is required`);
    return;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push(`${name} must use http or https`);
    }
  } catch {
    issues.push(`${name} must be an absolute URL`);
  }
}

function validatedPort(value: string | undefined, name: string, issues: string[]): number {
  const raw = value?.trim() || "";
  if (!/^\d+$/.test(raw)) {
    issues.push(`${name} must be an integer from 1 through 65535`);
    return 0;
  }
  const port = Number(raw);
  if (port < 1 || port > 65_535) {
    issues.push(`${name} must be an integer from 1 through 65535`);
  }
  return port;
}

/**
 * Validate the normal production startup contract before a database handle is
 * opened. Development and tests retain their local defaults.
 */
export function validateRuntimeConfiguration(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
  const paths = resolveRuntimePaths(runtimeEnv);
  if (runtimeEnv.NODE_ENV !== "production") return paths;

  const issues: string[] = [];
  const role = runtimeEnv.QOOPIA_SERVER_ROLE?.trim();
  if (role !== "canonical" && role !== "legacy-readonly") {
    issues.push("QOOPIA_SERVER_ROLE must be canonical or legacy-readonly");
  }
  validatedPort(runtimeEnv.QOOPIA_PORT, "QOOPIA_PORT", issues);

  assertAbsoluteEnv(runtimeEnv, "QOOPIA_ROOT", issues);
  assertAbsoluteEnv(runtimeEnv, "QOOPIA_DATA_DIR", issues);
  assertAbsoluteEnv(runtimeEnv, "QOOPIA_LOG_DIR", issues);
  assertAbsoluteEnv(runtimeEnv, "QOOPIA_BACKUP_DIR", issues);

  const expectedPaths = {
    QOOPIA_DATA_DIR: path.join(paths.rootDir, "data"),
    QOOPIA_LOG_DIR: path.join(paths.rootDir, "logs"),
    QOOPIA_BACKUP_DIR: path.join(paths.rootDir, "backups"),
  };
  if (runtimeEnv.QOOPIA_STANDALONE === 'true' && runtimeEnv.QOOPIA_STANDALONE_LAYOUT) {
    try {
      const layout = JSON.parse(runtimeEnv.QOOPIA_STANDALONE_LAYOUT) as {root:string;logs:string};
      if (!path.isAbsolute(layout.root) || !path.isAbsolute(layout.logs) ||
          path.dirname(paths.rootDir) !== path.join(path.resolve(layout.root), 'generations') ||
          !/^generation-[a-f0-9-]{36}$/.test(path.basename(paths.rootDir))) throw new Error('layout');
      expectedPaths.QOOPIA_BACKUP_DIR = path.join(path.resolve(layout.root), 'backups');
      expectedPaths.QOOPIA_LOG_DIR = path.resolve(layout.logs);
    } catch { issues.push('Invalid standalone generation layout'); }
  }
  for (const [name, expected] of Object.entries(expectedPaths)) {
    const value = runtimeEnv[name]?.trim();
    if (value && path.isAbsolute(value) && normalizedAbsolute(value) !== expected) {
      issues.push(`${name} must resolve to ${expected} under QOOPIA_ROOT`);
    }
  }

  const autoMigrate = runtimeEnv.QOOPIA_AUTO_MIGRATE?.trim();
  if (autoMigrate && autoMigrate !== "false") {
    issues.push(
      "QOOPIA_AUTO_MIGRATE must be false on service startup; use bun run migrate explicitly",
    );
  }

  const expectedSha = runtimeEnv.QOOPIA_EXPECTED_RELEASE_SHA?.trim() || "";
  if (!COMMIT_SHA_RE.test(expectedSha)) {
    issues.push("QOOPIA_EXPECTED_RELEASE_SHA must be a lowercase 40-character commit SHA");
  }
  if (!runtimeEnv.QOOPIA_RELEASE_STAMP_PATH?.trim()) {
    issues.push("QOOPIA_RELEASE_STAMP_PATH is required");
  }
  if (!runtimeEnv.QOOPIA_ADMIN_SECRET?.trim()) {
    issues.push("QOOPIA_ADMIN_SECRET is required");
  }
  assertUrlEnv(runtimeEnv, "QOOPIA_PUBLIC_URL", issues);

  if (issues.length > 0) {
    throw new Error(
      `Invalid Qoopia production configuration:\n- ${issues.join("\n- ")}`,
    );
  }
  return paths;
}

/** Validate non-secret operator inputs used to render the release compose. */
export function validateReleaseInputs(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): ReleaseInputs {
  const issues: string[] = [];
  const imageRef = runtimeEnv.QOOPIA_IMAGE_REF?.trim() || "";
  const releaseSha = runtimeEnv.QOOPIA_RELEASE_SHA?.trim() || "";
  const rootDir = runtimeEnv.QOOPIA_ROOT?.trim() || "";
  const serverRole = runtimeEnv.QOOPIA_SERVER_ROLE?.trim() || "";
  const port = validatedPort(runtimeEnv.QOOPIA_PORT, "QOOPIA_PORT", issues);

  if (!IMMUTABLE_IMAGE_RE.test(imageRef)) {
    issues.push(
      "QOOPIA_IMAGE_REF must be a registry digest (name@sha256:...) or local image ID (sha256:...)",
    );
  }
  if (!COMMIT_SHA_RE.test(releaseSha)) {
    issues.push("QOOPIA_RELEASE_SHA must be a lowercase 40-character commit SHA");
  }
  if (!rootDir || !path.isAbsolute(rootDir)) {
    issues.push("QOOPIA_ROOT must be an absolute path");
  }
  if (serverRole !== "canonical" && serverRole !== "legacy-readonly") {
    issues.push("QOOPIA_SERVER_ROLE must be canonical or legacy-readonly");
  }
  const autoMigrate = runtimeEnv.QOOPIA_AUTO_MIGRATE?.trim();
  if (autoMigrate && autoMigrate !== "false") {
    issues.push("QOOPIA_AUTO_MIGRATE must be false in release inputs");
  }

  if (issues.length > 0) {
    throw new Error(
      `Invalid Qoopia release inputs:\n- ${issues.join("\n- ")}`,
    );
  }
  return {
    imageRef,
    releaseSha,
    rootDir: normalizedAbsolute(rootDir),
    serverRole: serverRole as ReleaseInputs["serverRole"],
    port,
  };
}
