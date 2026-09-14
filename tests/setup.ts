/**
 * Test preload: redirects QOOPIA_* directories to a temp location before
 * any module (including db/connection.ts) reads env. Loaded via bunfig.toml
 * [test].preload.
 *
 * Each `bun test` run gets a fresh temp dir that is removed on process exit,
 * so tests never touch the developer's real ~/.qoopia data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-test-"));

process.env.QOOPIA_DATA_DIR = path.join(tmpRoot, "data");
process.env.QOOPIA_LOG_DIR = path.join(tmpRoot, "logs");
process.env.QOOPIA_BACKUP_DIR = path.join(tmpRoot, "backups");
process.env.QOOPIA_PORT = process.env.QOOPIA_PORT ?? "0";
process.env.QOOPIA_LOG_LEVEL = process.env.QOOPIA_LOG_LEVEL ?? "error";
process.env.QOOPIA_ADMIN_SECRET = process.env.QOOPIA_ADMIN_SECRET ?? "test-admin-secret";
// Pin a known dashboard session secret in the preload so all test files
// see the same value regardless of which one bun loads first. Otherwise
// `_sessionKey` (cached lazily on first request inside dashboard-api) can
// be resolved against a fallback before a later test file assigns its own
// QOOPIA_SESSION_SECRET — making cookies signed in that file fail server
// verification (CI vs local file ordering differs).
process.env.QOOPIA_SESSION_SECRET =
  process.env.QOOPIA_SESSION_SECRET ??
  "qdash-test-session-secret-do-not-ship-2026-04-27";

process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// Legacy HTTP fixtures remain explicit; built-in inference is qualified separately.
process.env.QOOPIA_EMBED_PROVIDER="ollama";
process.env.QOOPIA_AUTO_EMBED="false";
process.env.QOOPIA_ROOT=tmpRoot;
