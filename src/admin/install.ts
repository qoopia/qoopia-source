import fs from "node:fs";
import { PRODUCT_VERSION } from "../utils/product-version.ts";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { getPendingMigrations } from "../db/migrate.ts";
import { db } from "../db/connection.ts";
import { createWorkspace } from "./workspaces.ts";
import { createAgent } from "./agents.ts";
import { env } from "../utils/env.ts";
import { ensureSafeDir } from "../utils/fs-perms.ts";
import { getRolePreset, listRolePresets } from "./templates.ts";
import { ulid } from "ulid";
import { nowIso } from "../utils/errors.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function banner(title: string) {
  console.log("\n┌─────────────────────────────────────────────┐");
  console.log(`│  ${title.padEnd(43)}│`);
  console.log("└─────────────────────────────────────────────┘\n");
}

function step(msg: string) {
  console.log(`✓ ${msg}`);
}

function findBun(): string {
  try {
    return execSync("which bun", { encoding: "utf8" }).trim();
  } catch {
    // Fallback guesses
    for (const candidate of [
      path.join(os.homedir(), ".bun/bin/bun"),
      "/opt/homebrew/bin/bun",
      "/usr/local/bin/bun",
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error("bun not found — install Bun first (https://bun.sh)");
  }
}

// ---- Interactive prompt helpers ----

function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function choose(question: string, options: string[]): Promise<string> {
  console.log(`\n  ${question}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    (${i + 1}) ${options[i]}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("  Choice: ", (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]!);
      } else {
        resolve(options[0]!); // default to first
      }
    });
  });
}

export interface InstallOpts {
  stewardName?: string;
  stewardRole?: string;
  yes?: boolean;
}

export async function install(opts: InstallOpts = {}) {
  const start = Date.now();
  banner(`Qoopia ${PRODUCT_VERSION} installer`);

  // 1. Directories — all three under ~/.qoopia must be 0700; QSEC-003.
  ensureSafeDir(env.DATA_DIR);
  ensureSafeDir(env.LOG_DIR);
  ensureSafeDir(env.BACKUP_DIR);
  step(`Data directory: ${env.DATA_DIR}`);
  step(`Logs directory: ${env.LOG_DIR}`);
  step(`Backups directory: ${env.BACKUP_DIR}`);

  // 2. Schema changes are never hidden inside service installation. The
  // operator must run the one-shot migration command first so its integrity
  // preflight and backup are visible in the operation log.
  const pendingMigrations = getPendingMigrations();
  if (pendingMigrations.length > 0) {
    throw new Error(
      `Installer refused: ${pendingMigrations.length} pending migration(s). ` +
        "Run `bun run migrate` explicitly, then rerun install-service.",
    );
  }
  step("Schema is current");

  // 3. Default workspace
  let workspaceSlug = "default";
  const existing = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug);
  if (!existing) {
    createWorkspace({ name: "Default", slug: workspaceSlug });
    step(`Workspace created: ${workspaceSlug}`);
  } else {
    step(`Workspace already exists: ${workspaceSlug}`);
  }

  // 4. Steward setup (interactive or via flags)
  let stewardName = opts.stewardName;
  let stewardRole = opts.stewardRole;

  if (!stewardName && isInteractive() && !opts.yes) {
    console.log("\n  ─── Steward Agent Setup ───\n");
    console.log("  The steward manages Qoopia through chat (create agents, onboard, etc.).\n");
    stewardName = await ask("Primary agent name (will become steward)", "Alan");
    const presets = listRolePresets();
    stewardRole = await choose(
      "Select steward's role preset:",
      presets.map((p) => `${p.name} — ${p.displayName}`),
    );
    // Extract preset name from "name — displayName" format
    stewardRole = stewardRole.split(" — ")[0]!;
  }

  // Create steward agent (or fallback admin agent)
  let agentKey: string | null = null;
  let agentName: string;
  let agentType: string;
  let bootstrapCount = 0;
  let systemPrompt: string | null = null;

  if (stewardName) {
    agentName = stewardName;
    agentType = "steward";
  } else {
    agentName = "admin";
    agentType = "standard";
  }

  const agentExists = db
    .prepare(
      `SELECT id FROM agents WHERE name = ? AND workspace_id = (SELECT id FROM workspaces WHERE slug = ?)`,
    )
    .get(agentName, workspaceSlug);

  if (!agentExists) {
    const created = createAgent({
      name: agentName,
      workspaceSlug,
      type: agentType as "standard" | "claude-privileged" | "steward",
    });
    agentKey = created.api_key;

    // Bootstrap notes from role preset (if steward with role)
    if (agentType === "steward" && stewardRole) {
      try {
        const preset = getRolePreset(stewardRole);
        const now = nowIso();
        for (const note of preset.bootstrapNotes) {
          const noteId = ulid();
          db.prepare(
            `INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, tags, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, '{}', ?, 'installer', ?, ?)`,
          ).run(
            noteId,
            created.workspace_id,
            created.id,
            note.type,
            note.text,
            JSON.stringify(note.tags),
            now,
            now,
          );
          bootstrapCount++;
        }
        systemPrompt = preset.systemPrompt;
        step(`Steward '${agentName}' created with role '${stewardRole}' (${bootstrapCount} bootstrap notes)`);
      } catch (e) {
        step(`Steward '${agentName}' created (role preset '${stewardRole}' failed: ${e})`);
      }
    } else {
      step(`Agent '${agentName}' created (type: ${agentType})`);
    }
  } else {
    step(`Agent '${agentName}' already exists (use \`qoopia admin rotate-key ${agentName}\` to get a new key)`);
  }

  // 4b. Ingest daemon agent — idempotent (Phase 7a)
  const INGEST_KEY_PATH = path.join(os.homedir(), ".qoopia", "ingest.key");
  const ingestExists = db
    .prepare(`SELECT id FROM agents WHERE name = 'tailer' AND workspace_id = (SELECT id FROM workspaces WHERE slug = ?)`)
    .get(workspaceSlug);
  if (!ingestExists) {
    const ingestCreated = createAgent({
      name: "tailer",
      workspaceSlug,
      type: "ingest-daemon",
    });
    fs.mkdirSync(path.dirname(INGEST_KEY_PATH), { recursive: true });
    fs.writeFileSync(INGEST_KEY_PATH, ingestCreated.api_key, "utf8");
    fs.chmodSync(INGEST_KEY_PATH, 0o600);
    step(`Ingest daemon 'tailer' created, key saved to ${INGEST_KEY_PATH}`);
  } else {
    step(`Ingest daemon 'tailer' already exists (${INGEST_KEY_PATH})`);
  }

  // 5. launchd plist
  const bunPath = findBun();
  const qoopiaEntry = path.join(PROJECT_ROOT, "src/index.ts");
  const plistTemplate = fs.readFileSync(
    path.join(PROJECT_ROOT, "templates/com.qoopia.mcp.plist"),
    "utf8",
  );

  // QRERUN-001: persist a randomly-generated QOOPIA_ADMIN_SECRET into the
  // plist so /oauth/authorize is always gated on owner consent. Reuse an
  // existing one if found (idempotent install) — never silently rotate it,
  // because that would invalidate any consent flow already trusted by
  // Claude.ai etc.
  const adminSecretPath = path.join(env.DATA_DIR, "admin-secret");
  let adminSecret: string;
  if (fs.existsSync(adminSecretPath)) {
    adminSecret = fs.readFileSync(adminSecretPath, "utf8").trim();
    // QTHIRD-002 / QFOURTH-002: chmod 0600 on the reuse path too —
    // fs.writeFileSync sets mode only at create time, so a file that was
    // created with looser perms (or whose mode drifted) would otherwise
    // stay readable by other local users.
    // Failure here is FATAL: a quiet warning lets the install finish with
    // a world-readable secret on disk, which is exactly the leak we are
    // hardening against. Codex 4th review explicitly required throw, not
    // warn, so the operator sees and fixes the underlying perm issue
    // before the daemon ever uses the secret.
    try {
      fs.chmodSync(adminSecretPath, 0o600);
    } catch (err) {
      throw new Error(
        `chmod 0600 on ${adminSecretPath} failed: ${(err as Error).message} — refusing to continue with possibly world-readable admin secret`,
      );
    }
    step(`Reusing existing admin secret from ${adminSecretPath} (chmod 0600 enforced)`);
  } else {
    adminSecret = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(adminSecretPath, adminSecret + "\n", { encoding: "utf8", mode: 0o600 });
    step(`Generated admin secret → ${adminSecretPath} (chmod 0600)`);
  }

  const plist = plistTemplate
    .replace(/{{BUN_PATH}}/g, bunPath)
    .replace(/{{QOOPIA_ENTRY}}/g, qoopiaEntry)
    .replace(/{{QOOPIA_ROOT}}/g, env.ROOT_DIR)
    .replace(/{{QOOPIA_DATA_DIR}}/g, env.DATA_DIR)
    .replace(/{{QOOPIA_PORT}}/g, String(env.PORT))
    .replace(/{{LOG_DIR}}/g, env.LOG_DIR)
    .replace(/{{BACKUP_DIR}}/g, env.BACKUP_DIR)
    .replace(/{{QOOPIA_PUBLIC_URL}}/g, env.PUBLIC_URL)
    .replace(/{{QOOPIA_ADMIN_SECRET}}/g, adminSecret)
    .replace(/{{WORKING_DIR}}/g, PROJECT_ROOT);

  const plistDir = path.join(os.homedir(), "Library/LaunchAgents");
  fs.mkdirSync(plistDir, { recursive: true });
  const plistPath = path.join(plistDir, "com.qoopia.mcp.plist");
  fs.writeFileSync(plistPath, plist, "utf8");
  // QTHIRD-002 / QFOURTH-002: the plist embeds QOOPIA_ADMIN_SECRET — lock
  // it down to owner-only so other local users can't read the secret out
  // of the launchd config. fs.writeFileSync uses the process umask by
  // default, which on a typical Mac leaves it world-readable.
  // Failure here is FATAL for the same reason as above: a warn would let
  // a world-readable plist sit in ~/Library/LaunchAgents until next
  // reboot. Codex 4th review required throw.
  try {
    fs.chmodSync(plistPath, 0o600);
  } catch (err) {
    throw new Error(
      `chmod 0600 on ${plistPath} failed: ${(err as Error).message} — refusing to continue with possibly world-readable LaunchAgent plist`,
    );
  }
  step(`LaunchAgent plist written: ${plistPath} (chmod 0600)`);

  // 6. Load service (unload first if already loaded)
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
    step("LaunchAgent loaded");
  } catch (err) {
    console.warn(
      `⚠ launchctl load failed (you can run the server manually with \`bun run src/index.ts\`): ${err}`,
    );
  }

  // 6b. archive-stale weekly cron (qsearch-lifecycle PR).
  // Best-effort: failure here does NOT abort install — the main MCP
  // service is what matters. Operator can re-run install or manually
  // load the plist later.
  try {
    const archivePlistTemplatePath = path.join(
      PROJECT_ROOT,
      "templates/com.qoopia.archive-stale.plist",
    );
    if (fs.existsSync(archivePlistTemplatePath)) {
      const archivePlistTemplate = fs.readFileSync(
        archivePlistTemplatePath,
        "utf8",
      );
      const archivePlist = archivePlistTemplate
        .replace(/{{BUN_PATH}}/g, bunPath)
        .replace(/{{WORKING_DIR}}/g, PROJECT_ROOT)
        .replace(/{{QOOPIA_ROOT}}/g, env.ROOT_DIR)
        .replace(/{{QOOPIA_DATA_DIR}}/g, env.DATA_DIR)
        .replace(/{{LOG_DIR}}/g, env.LOG_DIR);
      const archivePlistPath = path.join(
        plistDir,
        "com.qoopia.archive-stale.plist",
      );
      fs.writeFileSync(archivePlistPath, archivePlist, "utf8");
      // No embedded secrets in this plist, but match owner-only perms
      // for consistency with com.qoopia.mcp.plist.
      try {
        fs.chmodSync(archivePlistPath, 0o600);
      } catch (err) {
        console.warn(
          `⚠ chmod 0600 on ${archivePlistPath} failed: ${(err as Error).message}`,
        );
      }
      try {
        execSync(`launchctl unload "${archivePlistPath}"`, { stdio: "ignore" });
      } catch {}
      try {
        execSync(`launchctl load "${archivePlistPath}"`, { stdio: "ignore" });
        step("archive-stale cron loaded (Sunday 03:00 weekly)");
      } catch (err) {
        console.warn(
          `⚠ archive-stale launchctl load failed: ${err}. Run manually with \`bun run scripts/archive-stale.ts\`.`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `⚠ archive-stale cron setup skipped: ${(err as Error).message}`,
    );
  }

  // 7. Health probe
  const probeStart = Date.now();
  let up = false;
  while (Date.now() - probeStart < 15_000) {
    try {
      const resp = await fetch(`http://localhost:${env.PORT}/health`);
      if (resp.ok) {
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  if (up) step(`Server responding on http://localhost:${env.PORT}`);
  else
    console.warn(
      `⚠ Server not reachable after 15s. Check logs at ${env.LOG_DIR}/qoopia.stderr.log`,
    );

  // 8. Summary
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log("\n---------------------------------------------");
  console.log(`  INSTALLATION COMPLETE -- ${elapsed} seconds`);
  console.log("---------------------------------------------\n");
  console.log(`  MCP URL:   http://localhost:${env.PORT}/mcp`);
  if (agentKey) {
    console.log(`\n  ${agentType === "steward" ? "Steward" : "Admin"} API key:  ${agentKey}`);
    console.log("\n  ⚠ Save this API key — it won't be shown again.\n");
    console.log("  MCP config (copy to ~/.claude.json or your MCP client):\n");
    console.log("  {");
    console.log('    "qoopia": {');
    console.log('      "type": "streamable-http",');
    console.log(`      "url": "http://localhost:${env.PORT}/mcp",`);
    console.log(`      "headers": {"Authorization": "Bearer ${agentKey}"}`);
    console.log("    }");
    console.log("  }\n");
    console.log(`  Claude Code CLI:`);
    console.log(`  claude mcp add qoopia --transport streamable-http \\`);
    console.log(`    --url http://localhost:${env.PORT}/mcp \\`);
    console.log(`    --header "Authorization: Bearer ${agentKey}"\n`);
  }
  if (systemPrompt) {
    console.log("  ─── System Prompt (copy to agent config) ───\n");
    console.log(systemPrompt);
    console.log("  ─── End System Prompt ───\n");
  }
  if (agentType === "steward") {
    console.log("  Next steps:");
    console.log("    1. Copy the API key to your password manager");
    console.log("    2. Add the MCP config to your agent's settings");
    console.log("    3. Copy the system prompt to your agent's config");
    console.log(`    4. Start a chat with ${agentName} — it can now manage Qoopia`);
    console.log(`    5. Try: "show all agents in Qoopia"\n`);
  } else {
    console.log("  Next steps:");
    console.log("    qoopia admin create-agent <name> --workspace default [--type steward]");
    console.log("    qoopia status");
    console.log("    qoopia logs\n");
  }
}
