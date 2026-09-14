#!/usr/bin/env bun
import { PRODUCT_VERSION } from "./utils/product-version.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { install, type InstallOpts } from "./admin/install.ts";
import { assertSchemaCurrent, getPendingMigrations } from "./db/migrate.ts";
import {
  createAgent,
  listAgents,
  rotateAgentKey,
  deleteAgent,
  setAgentType,
  type AgentType,
} from "./admin/agents.ts";
import { createWorkspace, listWorkspaces } from "./admin/workspaces.ts";
import {
  registerClaudeAgent,
  enableAutosession,
  disableAutosession,
  listClaudeAgents,
} from "./admin/claude-agents.ts";
import { env } from "./utils/env.ts";
import { db, closeDb, DB_PATH } from "./db/connection.ts";
import { adoptManagedSkill, bindManagedRoot, openManagedSession, materializeSession, removeSessionProjection, runCsvTask } from "./skills/adapter.ts";
import { authorityOperations, effectiveAuthority, apiError, handleAuthorityRequest } from "./api/authority.ts";
import { authenticate } from "./auth/middleware.ts";
import { bootstrapOwner } from "./auth/pairings.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];

function usage() {
  console.log(`Usage: qoopia <command> [args]

Commands:
  owner bootstrap --name <new-human-name> --workspace-name <name> | --workspace-id <existing-id>
                                                Local database OS owner only; creates a separate human, never promotes an agent
  capabilities                                  Show current scoped P1 schemas and effective configuration
  skill capture|revise|compile|review|accept|seal|assign|update|lifecycle|outcome|rate|loop|get|search|runbook --input <json-file>
  runtime configure|open|get|claim|authorize|observe --input <json-file>
  runtime bind --runtime-id ID --root ABSOLUTE_DIRECTORY
  runtime start --runtime-id ID --native-session REF --session-id ID
  runtime sync|cleanup --loadout-id ID
  runtime run --loadout-id ID --entry-id ID --csv FILE --auth-mode subscription|subscription-store|api-key --model EXACT_MODEL --effort high [--login-backend BACKEND --login-store DIRECTORY]
                                                Typed P1 operation using QOOPIA_API_KEY; mutations require idempotency and revision/digest
  pairing create|redeem --input <json-file>       Scoped, single-use enrollment; redeem returns a fresh key once
  principal revoke --input <json-file>           Revoke a principal at its exact policy epoch
  publisher-key register --input <json-file>     Register an owner's public signing key
  operation get --input <json-file>              Inspect the requester's durable command result
  install [--steward-name N --steward-role R]    Run first-time installer (interactive or flags)
  uninstall                                     Stop service + unload plist
  status                                        Health check
  logs [--follow]                               Tail server log
  version                                       Print version and DB schema version
  backup [--to <path>]                          Manual SQLite backup
  admin create-workspace <name> [--slug <slug>]
  admin list-workspaces
  admin create-agent <name> --workspace <slug> [--type standard|claude-privileged|steward|ingest-daemon]
  admin list-agents
  admin rotate-key <name> --workspace <slug>
  admin delete-agent <name> --workspace <slug>
  admin set-type <name> --workspace <slug> --type <type>
  admin promote-steward <name> --workspace <slug>
  admin register-claude-agent <agent-name> --workspace <slug> --cwd-prefix <path> [--no-autosession]
  admin enable-autosession --workspace <slug> --cwd-prefix <path>
  admin disable-autosession --workspace <slug> --cwd-prefix <path>
  admin list-claude-agents --workspace <slug>
  v4-contract                                    Validate the frozen P05 live tool contract
  v4-smoke --fixture-workspace                   Run a test-only scratch brief/recall smoke
`);
}

function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return argv[i + 1];
}

function need(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  // CLI commands must never smuggle schema writes into an unrelated action.
  // Health/log/version/help remain inspectable; every DB operation requires an
  // explicitly current schema produced by `bun run migrate`.
  if (
    cmd !== undefined &&
    !["-h", "--help", "help", "version", "status", "logs", "v4-contract", "v4-smoke"].includes(cmd)
  ) {
    assertSchemaCurrent(`qoopia ${cmd}`);
  }
  try {
    switch (cmd) {
      case "owner": {
        if (argv[1] !== "bootstrap") throw new Error("Only local owner bootstrap is supported");
        const options = new Map<string, string>();
        for (let i = 2; i < argv.length; i += 2) {
          const option = argv[i]!, value = argv[i + 1];
          if (!["--name", "--workspace-name", "--workspace-id"].includes(option) || options.has(option) || !value || value.startsWith("--")) {
            throw new Error("Use --name and exactly one of --workspace-name or --workspace-id; no agent promotion or owner replacement is supported");
          }
          options.set(option, value);
        }
        // The local OS session is the bootstrap authority (master §10.2).
        // A remote credential or a legacy machine role is never sufficient.
        const uid = process.getuid?.();
        if (uid === undefined || process.geteuid?.() !== uid || fs.statSync(DB_PATH).uid !== uid) {
          throw new Error("Owner bootstrap requires the database owner's local OS session");
        }
        console.log(JSON.stringify(bootstrapOwner(db, options.get("--name") ?? "", options.get("--workspace-name"), options.get("--workspace-id")), null, 2));
        return;
      }
      case "capabilities": {
        const auth = authenticate(new Request("http://local", { headers: { authorization: `Bearer ${process.env.QOOPIA_API_KEY ?? ""}` } }));
        console.log(JSON.stringify(effectiveAuthority(auth ?? undefined), null, 2));
        return;
      }
      case "skill":
      case "runtime":
      case "pairing":
      case "principal":
      case "publisher-key":
      case "operation": {
        if (cmd === "runtime" && ["bind","sync","start","run","cleanup","adopt-preview","adopt"].includes(argv[1] ?? "")) {
          const auth = authenticate(new Request("http://local", { headers: { authorization: `Bearer ${process.env.QOOPIA_API_KEY ?? ""}` } }));
          if (!auth) throw new Error("QOOPIA_API_KEY must authenticate the owner (bind) or enrolled runtime reporter");
          let result: unknown;
          if (argv[1] === "bind") result = bindManagedRoot(db,auth,need("runtime-id",arg("runtime-id")),need("root",arg("root")));
          else if (argv[1] === 'adopt-preview'||argv[1] === 'adopt') result=adoptManagedSkill(db,auth,{runtime_id:need('runtime-id',arg('runtime-id')),target:need('target',arg('target')),...(argv[1]==='adopt'?{preview_digest:need('preview-digest',arg('preview-digest')),skill_id:need('skill-id',arg('skill-id')),version_id:need('version-id',arg('version-id')),idempotency_key:need('idempotency-key',arg('idempotency-key'))}:{})});
          else if (argv[1] === "start") result = openManagedSession(db,auth,need("runtime-id",arg("runtime-id")),need("native-session",arg("native-session")),need("session-id",arg("session-id")));
          else if (argv[1] === "sync") result = materializeSession(db,auth,need("loadout-id",arg("loadout-id")));
          else if (argv[1] === "cleanup") result = removeSessionProjection(db,auth,need("loadout-id",arg("loadout-id")));
          else result = await runCsvTask(db,auth,{loadout_id:need("loadout-id",arg("loadout-id")),entry_id:need("entry-id",arg("entry-id")),csv:fs.readFileSync(need("csv",arg("csv")),"utf8"),auth_mode:need("auth-mode",arg("auth-mode")),model:need("model",arg("model")),effort:need("effort",arg("effort")),login_store:arg('login-store'),login_backend:arg('login-backend')});
          console.log(JSON.stringify(result,null,2)); return;
        }
        const filename = need("input", arg("input"));
        if (cmd === "pairing" && argv[1] === "redeem") {
          const response = await handleAuthorityRequest(new Request("http://local/api/v1/agent-pairings/redeem", {
            method: "POST", headers: { "content-type": "application/json" }, body: fs.readFileSync(filename, "utf8"),
          }));
          const text = await response.text();
          if (response.ok) console.log(text); else { console.error(text); process.exitCode = 1; }
          return;
        }
        const names: Record<string, string> = { "skill:import-review":"skill_import_review", "skill:import-resolve":"skill_import_resolve", "skill:capture":"skill_capture", "skill:accept":"skill_accept", "skill:assign":"skill_assign", "skill:update":"skill_assignment_update", "skill:lifecycle":"skill_lifecycle", "skill:feedback":"skill_feedback", "skill:outcome":"skill_outcome", "skill:rate":"skill_rate", "skill:loop":"skill_loop",
          "runtime:configure":"runtime_configure", "runtime:open":"skill_session_open", "runtime:get":"skill_session_get", "runtime:claim":"runtime_claim", "runtime:authorize":"skill_run_authorize", "runtime:observe":"skill_observe", "skill:revise": "skill_draft_revise", "skill:compile": "skill_compile", "skill:review": "skill_review",
          "skill:seal": "skill_seal", "skill:get": "skill_get", "skill:search": "skill_search", "skill:runbook": "skill_render_runbook",
          "pairing:create": "agent_pairing_create", "principal:revoke": "principal_revoke", "publisher-key:register": "publisher_key_register", "operation:get": "operation_get" };
        const op = authorityOperations.find((o) => o.name === names[`${cmd}:${argv[1] ?? ""}`]);
        if (!op) throw new Error("Unknown typed operation; use qoopia help. Mutation inputs require idempotency_key and expected_revision/digest");
        const auth = authenticate(new Request("http://local", { headers: { authorization: `Bearer ${process.env.QOOPIA_API_KEY ?? ""}` } }));
        if (!auth) throw new Error("QOOPIA_API_KEY must authenticate a scoped principal");
        try {
          const input = op.schema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
          console.log(JSON.stringify(await op.handler(auth, input, db), null, 2));
        } catch (error) { console.error(JSON.stringify(apiError(error).error)); process.exitCode = 1; }
        return;
      }
      case undefined:
      case "-h":
      case "--help":
      case "help":
        usage();
        return;
      case "version": {
        let schemaVersion = 0;
        try {
          const ver = db
            .prepare(`SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1`)
            .get() as { version: number } | undefined;
          schemaVersion = ver?.version ?? 0;
        } catch {
          // A fresh database has no schema_versions table yet.
        }
        const pending = getPendingMigrations();
        console.log(
          `qoopia ${PRODUCT_VERSION}  schema ${schemaVersion}  pending ${pending.length}`,
        );
        return;
      }
      case "status": {
        try {
          const res = await fetch(`http://localhost:${env.PORT}/health`);
          if (res.ok) {
            const body = (await res.json()) as Record<string, unknown>;
            console.log(`running  port=${env.PORT}  uptime=${body.uptime}s`);
          } else {
            console.log(`stopped  (HTTP ${res.status})`);
          }
        } catch {
          console.log(`stopped  (no response on port ${env.PORT})`);
        }
        return;
      }
      case "logs": {
        const follow = argv.includes("--follow");
        const file = path.join(env.LOG_DIR, "qoopia.stdout.log");
        if (!fs.existsSync(file)) {
          console.log(`(no log file at ${file})`);
          return;
        }
        if (follow) {
          execSync(`tail -f "${file}"`, { stdio: "inherit" });
        } else {
          execSync(`tail -n 50 "${file}"`, { stdio: "inherit" });
        }
        return;
      }
      case "v4-contract": {
        const child = Bun.spawnSync({
          cmd: [process.execPath, "run", "scripts/v4-contract-snapshot.ts", "--check"],
          cwd: process.cwd(),
          env: { ...process.env },
          stdout: "inherit",
          stderr: "inherit",
        });
        if (child.exitCode !== 0) process.exit(child.exitCode);
        return;
      }
      case "v4-smoke": {
        if (!argv.includes("--fixture-workspace") || process.env.NODE_ENV !== "test") {
          throw new Error("v4-smoke requires --fixture-workspace and NODE_ENV=test; it is scratch-only");
        }
        const child = Bun.spawnSync({
          cmd: [process.execPath, "run", "scripts/v4-cli-smoke.ts"],
          cwd: process.cwd(),
          env: { ...process.env },
          stdout: "inherit",
          stderr: "inherit",
        });
        if (child.exitCode !== 0) process.exit(child.exitCode);
        return;
      }
      case "install":
        await install({
          stewardName: arg("steward-name"),
          stewardRole: arg("steward-role"),
          yes: argv.includes("--yes"),
        });
        return;
      case "uninstall": {
        const plistPath = path.join(
          os.homedir(),
          "Library/LaunchAgents/com.qoopia.mcp.plist",
        );
        try {
          execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
        } catch {}
        if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
        console.log("Service stopped and plist removed.");
        console.log(`Data at ${env.DATA_DIR} preserved (rm -rf ~/.qoopia to delete).`);
        return;
      }
      case "backup": {
        const to = arg("to", path.join(env.BACKUP_DIR, `qoopia-manual-${Date.now()}.db`));
        // Validate path to avoid dynamic SQL injection — only allow safe characters
        if (!/^[a-zA-Z0-9/_.\-~]+$/.test(to!)) {
          console.error(`Backup path contains unsafe characters: ${to}`);
          process.exit(1);
        }
        db.prepare("VACUUM INTO ?").run(to as string);
        console.log(`Backup written to ${to}`);
        return;
      }
      case "admin": {
        const sub = argv[1];
        switch (sub) {
          case "create-workspace": {
            const name = argv[2];
            if (!name) return console.error("Missing workspace name");
            const ws = createWorkspace({ name, slug: arg("slug") });
            console.log(`Created workspace ${ws.slug} (${ws.id})`);
            return;
          }
          case "list-workspaces": {
            for (const w of listWorkspaces() as Array<{ name: string; slug: string; id: string }>) {
              console.log(`${w.slug.padEnd(20)} ${w.name}  (${w.id})`);
            }
            return;
          }
          case "create-agent": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            const type = (arg("type", "standard") as AgentType);
            const created = createAgent({
              name,
              workspaceSlug: workspace,
              type,
            });
            console.log(`Created agent '${name}' in ${workspace}`);
            console.log(`API key: ${created.api_key}`);
            console.log("(Save this — it won't be shown again.)");
            return;
          }
          case "list-agents": {
            interface AgentRow {
              workspace_slug: string;
              name: string;
              type: string;
              active: number;
              last_seen: string | null;
            }
            for (const a of listAgents() as AgentRow[]) {
              console.log(
                `${a.workspace_slug.padEnd(18)} ${a.name.padEnd(16)} ${a.type.padEnd(18)} active=${a.active} last_seen=${a.last_seen || "-"}`,
              );
            }
            return;
          }
          case "rotate-key": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            const key = rotateAgentKey(name, workspace);
            console.log(`New API key for ${name}: ${key}`);
            return;
          }
          case "delete-agent": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            deleteAgent(name, workspace);
            console.log(`Agent ${name} deactivated.`);
            return;
          }
          case "set-type": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            const type = need("type", arg("type")) as AgentType;
            setAgentType(name, workspace, type);
            console.log(`Agent '${name}' type set to '${type}'.`);
            return;
          }
          case "promote-steward": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace", "default"));
            setAgentType(name, workspace, "steward");
            console.log(`Agent '${name}' promoted to steward.`);
            console.log("Admin MCP tools are now available to this agent (no restart needed).");
            return;
          }
          case "register-claude-agent": {
            const agentName = argv[2];
            if (!agentName) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            const cwdPrefix = need("cwd-prefix", arg("cwd-prefix"));
            const noAutosession = argv.includes("--no-autosession");
            const rec = registerClaudeAgent({
              workspaceSlug: workspace,
              agentName,
              cwdPrefix,
              autosessionEnabled: !noAutosession,
            });
            console.log(`Registered Claude Code agent '${agentName}' → cwd_prefix: ${cwdPrefix}`);
            console.log(`  id: ${rec.id}  autosession: ${rec.autosession_enabled ? "enabled" : "disabled"}`);
            return;
          }
          case "enable-autosession": {
            const workspace = need("workspace", arg("workspace"));
            const cwdPrefix = need("cwd-prefix", arg("cwd-prefix"));
            enableAutosession({ workspaceSlug: workspace, cwdPrefix });
            console.log(`Autosession enabled for cwd_prefix: ${cwdPrefix}`);
            return;
          }
          case "disable-autosession": {
            const workspace = need("workspace", arg("workspace"));
            const cwdPrefix = need("cwd-prefix", arg("cwd-prefix"));
            disableAutosession({ workspaceSlug: workspace, cwdPrefix });
            console.log(`Autosession disabled for cwd_prefix: ${cwdPrefix}`);
            return;
          }
          case "list-claude-agents": {
            const workspace = need("workspace", arg("workspace"));
            const rows = listClaudeAgents(workspace);
            if (rows.length === 0) {
              console.log("(no Claude Code agents registered)");
              return;
            }
            for (const r of rows) {
              console.log(
                `${r.agent_name.padEnd(16)} ${r.cwd_prefix.padEnd(50)} autosession=${r.autosession_enabled ? "on" : "off"}  (${r.id})`,
              );
            }
            return;
          }
          default:
            usage();
            return;
        }
      }
      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        process.exit(2);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  closeDb();
  process.exit(1);
});
