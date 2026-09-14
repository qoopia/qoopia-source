/**
 * Phase 2 Item E — fat skills seed driver. Stands up a brand-new
 * sqlite DB in /tmp, runs every on-disk migration against it, then
 * encodes the seven Phase 2 Item E skills via skillUpsert + links
 * agentcomm-e2e-verification → agentcomm-protocol (documents
 * relation). Pure /tmp — production DB is never touched.
 *
 *   QOOPIA_DATA_DIR=/tmp/phase2e-<stamp> bun run scripts/phase2_item_e_seed_skills.ts
 *
 * Output is consumed by the Leo R1 review packet so the immutable
 * reference can quote concrete IDs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect data dirs BEFORE importing any module that reads env at
// load time (connection.ts caches the path).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase2e-"));
process.env.QOOPIA_DATA_DIR = path.join(root, "data");
process.env.QOOPIA_LOG_DIR = path.join(root, "logs");
process.env.QOOPIA_BACKUP_DIR = path.join(root, "backups");
process.env.QOOPIA_LOG_LEVEL = process.env.QOOPIA_LOG_LEVEL ?? "error";
process.env.QOOPIA_RECALL_MODE = "hybrid";
// Item E skills layer depends on entity_pages at the service layer.
// Both flags must be on for the seed to land.
process.env.QOOPIA_ENTITY_PAGES = "true";
process.env.QOOPIA_SKILLS = "true";

const { runMigrations } = await import("../src/db/migrate.ts");
const { createWorkspace } = await import("../src/admin/workspaces.ts");
const { upsertEntity, addLink } = await import("../src/services/entities.ts");
const { skillUpsert, skillRenderRunbook } = await import(
  "../src/services/skills.ts"
);

runMigrations();

const ws = createWorkspace({
  name: "Phase 2 Item E seed",
  slug: "phase2-item-e-seed",
});

// Seed a stub `agentcomm-protocol` entity so the documents relation
// from skill agentcomm-e2e-verification has a real target.
const acProtocol = upsertEntity({
  workspace_id: ws.id,
  type: "protocol",
  slug: "agentcomm-protocol",
  title: "AgentComm protocol",
  summary:
    "Durable inbox protocol with optional wake acceleration and loop guards. See " +
    "$QOOPIA_ROOT/docs/agentcomm-spec.md for the canonical spec.",
  metadata: { encoded_by: "phase2-item-e-seed" },
});

// ──────────────────────────────────────────────────────────────────
// 1. agentcomm-e2e-verification
// ──────────────────────────────────────────────────────────────────
const skill1 = skillUpsert({
  workspace_id: ws.id,
  slug: "agentcomm-e2e-verification",
  title: "AgentComm end-to-end verification",
  summary:
    "Verify the AgentComm durable inbox and optional wake pipeline between " +
    "two agents in a workspace. Runs against a scratch session, " +
    "exercises the loop-prevention guard, and confirms message " +
    "ordering on the receiver. Replaces the Item C R2 stub.",
  metadata: {
    skill_version: "1.0.0",
    owner_agent: "corsair-main",
    trigger_conditions: [
      "After any change to src/services/agent-comm.ts",
      "After any migration that touches agent_sessions or agent_messages",
      "Before declaring AgentComm GA in a new workspace",
    ],
    scope:
      "End-to-end AgentComm pipeline between two agents in the same workspace.",
    prerequisites: [
      "Two agents registered in the target workspace (use create_agent.py)",
      "QOOPIA_AGENT_COMM=true on the bot host",
      "Scratch test session free of prior messages",
    ],
    exact_steps: [
      "Open a fresh agent session via mcp__qoopia-corsair__agent_session_create",
      "From agent A, send a 'hello' message with topic E2E_VERIFY_<UTC>",
      "From agent B, agent_inbox; assert the message appears with the same topic",
      "From agent B, agent_reply 'ack'; assert agent_status on A shows the reply",
      "From agent A, agent_send a second message with the same topic; assert loop-prevention blocks if reply_to chain exceeds depth 6",
      "Close the session via agent_session_close on both ends",
    ],
    verification_gates: [
      "Step 3 inbox returns exactly one message and topic matches",
      "Step 4 ack arrives on A within 2s and contains 'ack' literal",
      "Step 5 returns LOOP_PREVENTION_DEPTH error code",
      "Session close idempotent — second call returns NOT_FOUND, not 500",
    ],
    failure_modes: [
      "If agent_inbox returns []: check QOOPIA_AGENT_COMM flag on receiver host",
      "If ack never arrives: check sessions.json for the receiver — orphaned session is the usual cause",
      "If loop-prevention does not fire: confirm AgentComm spec depth=6 default has not been overridden",
    ],
    rollback:
      "AgentComm sessions are advisory state — close the scratch session " +
      "via agent_session_close. No DB rollback needed; the verification " +
      "writes only into agent_sessions which the close call clears.",
    related_code_paths: [
      "src/services/agent-comm.ts",
      "migrations/014-agent-comm.sql",
      "$QOOPIA_ROOT/docs/agentcomm-spec.md",
    ],
    related_incidents: [
      "phase1-item-7-agentcomm-trust-rebuild — initial trust loss",
    ],
  },
});

addLink({
  workspace_id: ws.id,
  source_entity_id: skill1.id,
  target_entity_id: acProtocol.id,
  relation_type: "documents",
  source: "phase2-item-e-seed",
});

// ──────────────────────────────────────────────────────────────────
// 2. corsair-provider-guard-repair
// ──────────────────────────────────────────────────────────────────
const skill2 = skillUpsert({
  workspace_id: ws.id,
  slug: "corsair-provider-guard-repair",
  title: "Corsair Ductor provider/session auth repair",
  summary:
    "Re-establish the Anthropic provider guard on a Corsair Ductor " +
    "agent that has lost its session token (manifests as 401 from " +
    "Claude during a tool call). Uses the existing fork-installed " +
    "provider guard from Phase 1 item 7.",
  metadata: {
    skill_version: "1.0.0",
    owner_agent: "corsair-main",
    trigger_conditions: [
      "Agent surface returns 401 from Anthropic on tool calls",
      "$QOOPIA_ROOT/scripts/verify_provider_guard.sh exits non-zero",
      "Ductor logs show 'invalid session' on cold boot",
    ],
    scope:
      "Single-host Anthropic provider guard repair on Corsair. Does not cover headless Mac — see headless-mac-corsair-liveness-check for that path.",
    prerequisites: [
      "ssh access to the affected host as the bot user",
      "Vaultwarden CLI available with read scope on the provider entry",
      "Knowledge of the agent's bot_token slot in ~/.ductor/agents.json",
    ],
    exact_steps: [
      "Run $QOOPIA_ROOT/scripts/verify_provider_guard.sh — capture the exit code",
      "If exit 2 (session stale): run the provider re-auth flow via the Claude Code CLI auth helper (no token in CLI args)",
      "If exit 3 (token wiped): fetch the provider token from Vaultwarden via /srv/vaultwarden/tools/secret_tools/bw_safe_inspect.py with --slot anthropic-provider",
      "Restore the token to its agent slot via the standard agents.json edit path (never echo to terminal)",
      "Restart the affected agent: `touch ~/.ductor/restart-requested`",
      "Re-run verify_provider_guard.sh — must exit 0",
    ],
    verification_gates: [
      "verify_provider_guard.sh exits 0 after the repair",
      "A scratch tool call from the agent succeeds within 30s of restart",
      "No raw token written to any log or terminal during the repair",
    ],
    failure_modes: [
      "Provider returns 403 after repair: the workspace_id slot is wrong — check agents.json:<agent>.workspace_id",
      "Restart marker fails to fire: check inotify on ~/.ductor — Docker bind-mount can mask the marker",
      "verify_provider_guard.sh exits 4: the fork-installed guard binary is missing; re-run the Phase 1 item 7 install",
    ],
    rollback:
      "If the re-auth produces a worse state than the broken one, restore " +
      "the previous agents.json from /var/backups/ductor/agents-<UTC>.json " +
      "and re-touch ~/.ductor/restart-requested. Do not delete the token " +
      "manually from agents.json — that leaves the slot in a half-populated " +
      "state the supervisor refuses to load.",
    related_code_paths: [
      "$QOOPIA_ROOT/scripts/verify_provider_guard.sh",
      "/srv/vaultwarden/tools/secret_tools/bw_safe_inspect.py",
      "~/.ductor/agents.json",
    ],
    related_incidents: [
      "phase1-item-7-provider-guard-fork — origin of the fork-installed guard",
    ],
  },
});

// ──────────────────────────────────────────────────────────────────
// 3. qoopia-migration-ring-cutover
// ──────────────────────────────────────────────────────────────────
const skill3 = skillUpsert({
  workspace_id: ws.id,
  slug: "qoopia-migration-ring-cutover",
  title: "Qoopia migration ring cutover",
  summary:
    "Promote a Qoopia migration from shadow ring to canonical after " +
    "shadow_sync has confirmed parity for a 24h window. Placeholder " +
    "spec — full implementation lands in Phase 3+. The runbook lists " +
    "the gates that MUST hold before a cutover even when the tooling " +
    "still requires manual steps.",
  metadata: {
    skill_version: "0.1.0",
    owner_agent: "leo-agentcomm",
    trigger_conditions: [
      "shadow_sync conflict queue empty for the target migration for ≥ 24h",
      "Asхат GO to start the cutover window",
    ],
    scope:
      "Single migration cutover from shadow ring to canonical ring. Multi-migration bundles are out of scope — split them.",
    prerequisites: [
      "shadow_sync engine deployed (Phase 2 Item B)",
      "sync_conflicts CLI shows zero conflicts for the target migration",
      "Backup of canonical DB no older than 1h",
    ],
    exact_steps: [
      "Snapshot canonical DB via VACUUM INTO under /var/backups/qoopia/",
      "Run sync_conflicts.ts --target <migration-id> --report-only and confirm zero rows",
      "Set QOOPIA_RING_TARGET=<migration-id> on the canonical host",
      "Restart canonical via `touch ~/.ductor/restart-requested`",
      "Tail canonical logs for 10 min; abort if any sync-applied-hash mismatch fires",
      "Mark cutover complete in cutover_log table (Phase 3+ schema)",
    ],
    verification_gates: [
      "Zero conflicts in sync_conflicts.ts after restart",
      "Canonical and shadow row counts match for the migration's tables",
      "No ERROR-level lines in canonical logs during the 10 min watch",
    ],
    failure_modes: [
      "Conflict appears mid-watch: rollback immediately (see Rollback)",
      "Canonical refuses to boot post-restart: snapshot restore + investigation, do not retry the cutover",
      "Hash mismatch on a single row: pause cutover, dump both sides, hand to Leo for arbitration",
    ],
    rollback:
      "Restore the VACUUM INTO snapshot taken in step 1 over the canonical " +
      "DB file. Clear QOOPIA_RING_TARGET. Re-touch the restart marker. " +
      "shadow_sync continues to replicate forward so the failed cutover " +
      "does not lose any subsequent writes.",
    related_code_paths: [
      "src/services/shadow_sync.ts",
      "scripts/sync_conflicts.ts",
      "migrations/019-sync-conflict-queue.sql",
    ],
    related_incidents: [
      "phase2-item-b-shadow-sync — origin of the ring",
    ],
  },
});

// ──────────────────────────────────────────────────────────────────
// 4. no-raw-logs-telegram-infra-execution
// ──────────────────────────────────────────────────────────────────
const skill4 = skillUpsert({
  workspace_id: ws.id,
  slug: "no-raw-logs-telegram-infra-execution",
  title: "No-raw-logs Telegram infra execution",
  summary:
    "Run infra operations from a Telegram-driven Ductor agent without " +
    "ever writing a raw log line containing a credential, token, or " +
    "session cookie to disk or to chat. Cites the secret-safe rubric " +
    "from Phase 1 Item 7.",
  metadata: {
    skill_version: "1.0.0",
    owner_agent: "corsair-main",
    trigger_conditions: [
      "Any infra task that touches a secret (token rotation, provider repair, vault retrieval)",
      "Any task that runs `env`, `printenv`, or `set` on a host with bot env loaded",
    ],
    scope:
      "Bot-driven infra commands. Out of scope: end-user notes (those go through the noise filter, not this rubric).",
    prerequisites: [
      "Reviewed image contains src/utils/secret-guard.ts",
      "QOOPIA_LOG_LEVEL not set to 'debug' in prod (debug bypasses one redaction layer)",
    ],
    exact_steps: [
      "Before running any subshell: confirm the command does not include $TOKEN or %SECRET% style env interpolation",
      "Pipe potentially-leaky output through assertNoSecrets() at the service boundary (logger.ts already wraps for the standard log channels)",
      "Never echo a secret back to Telegram chat — use a status code (OK / ERR + redaction marker)",
      "For interactive commands (bw unlock, claude auth login), run them headless via the wrapper in /srv/vaultwarden/tools/secret_tools/bw_safe_inspect.py",
      "Audit the resulting log file post-run with `grep -E 'sk-|bw_|Bearer ' <log>` and assert zero matches",
    ],
    verification_gates: [
      "grep audit on the run's log file returns zero secret-pattern matches",
      "Telegram chat history contains no token-shaped strings (sk-, bearer, etc.)",
      "secret-guard.ts assertNoSecrets did not fire (would have thrown)",
    ],
    failure_modes: [
      "Token leaks into bot log: rotate the leaked secret immediately, then rebuild the log redaction allow-list",
      "assertNoSecrets fires on a legitimate string: extend the allow-list in secret-guard.ts; do NOT broaden the regex",
      "Bot-side env interpolation prints a token: kill the bot process with --no-history; rotate; then re-spawn",
    ],
    rollback:
      "If a secret has leaked, rollback is rotation of the leaked secret " +
      "(not just deletion of the log line). Rotate via the Vaultwarden " +
      "tools and re-issue the new token to all consumers before any " +
      "further infra operations on the affected agent.",
    related_code_paths: [
      "src/utils/secret-guard.ts",
      "src/utils/logger.ts",
      "$QOOPIA_ROOT/docs/secret-safe-rubric.md",
    ],
    related_incidents: [
      "phase1-item-7-secret-safe-rubric — origin",
    ],
  },
});

// ──────────────────────────────────────────────────────────────────
// 5. vaultwarden-secret-migration-retrieval-proof
// ──────────────────────────────────────────────────────────────────
const skill5 = skillUpsert({
  workspace_id: ws.id,
  slug: "vaultwarden-secret-migration-retrieval-proof",
  title: "Vaultwarden secret migration & retrieval proof",
  summary:
    "Migrate a secret into the Vaultwarden vault and produce a " +
    "retrieval proof without ever materializing the secret value " +
    "to a terminal, log, or chat. Uses the bw_safe_inspect.py wrapper.",
  metadata: {
    skill_version: "1.0.0",
    owner_agent: "corsair-main",
    trigger_conditions: [
      "Onboarding a new external API key into a Ductor agent",
      "Rotating an existing secret and verifying the new value works",
      "Verifying a vault entry still resolves before a high-risk operation",
    ],
    scope:
      "Single secret per invocation. Bulk migrations: split into one skill run per secret so the audit trail is granular.",
    prerequisites: [
      "Vaultwarden CLI authenticated on the host (bw login was completed out-of-band)",
      "/srv/vaultwarden/tools/secret_tools/bw_safe_inspect.py available",
      "Target slot id in the vault (do not write the value to a slot named after the secret content)",
    ],
    exact_steps: [
      "Confirm the destination slot does not already hold a different secret: bw_safe_inspect.py --slot <id> --metadata-only",
      "Stage the new secret via bw_safe_inspect.py --slot <id> --stage (reads from stdin; never accept the value as argv)",
      "Commit the staged secret via --commit (separate call so a CTRL-C between stage and commit leaves the prior state intact)",
      "Retrieval proof: bw_safe_inspect.py --slot <id> --hash-only — captures sha256(secret) and emits it; never the secret",
      "Hand the hash to the consumer service for a separate side-channel sha256 compare",
    ],
    verification_gates: [
      "--metadata-only after commit shows the expected slot title and updated_at",
      "--hash-only returns a 64-hex string with no other content",
      "Bot logs from the run contain zero base64 / sk- / bearer patterns",
    ],
    failure_modes: [
      "Stage succeeds but commit returns 409: the slot was edited concurrently — re-fetch and merge by hand",
      "--hash-only returns empty: the slot is empty; redo the stage/commit",
      "bw CLI session times out mid-stage: rerun bw login out-of-band, then resume from step 2",
    ],
    rollback:
      "If the commit lands a wrong value, the prior value is recoverable " +
      "from /var/backups/vaultwarden/<UTC>.json.enc — restore the slot " +
      "from there before any consumer reads the slot. If consumers have " +
      "already cached the bad value, also bounce them after the restore.",
    related_code_paths: [
      "/srv/vaultwarden/tools/secret_tools/bw_safe_inspect.py",
      "/srv/vaultwarden/docs/retrieval-proof.md",
    ],
    related_incidents: [
      "phase1-item-6-vault-bootstrap — origin of bw_safe_inspect.py",
    ],
  },
});

// ──────────────────────────────────────────────────────────────────
// 6. headless-mac-corsair-liveness-check
// ──────────────────────────────────────────────────────────────────
const skill6 = skillUpsert({
  workspace_id: ws.id,
  slug: "headless-mac-corsair-liveness-check",
  title: "Headless Mac / Corsair liveness check",
  summary:
    "Confirm the headless Mac mini and Corsair are both reachable, " +
    "running their bots, and reporting a fresh agent_status snapshot. " +
    "Used before any cross-host AgentComm verification.",
  metadata: {
    skill_version: "1.0.0",
    owner_agent: "corsair-main",
    trigger_conditions: [
      "Before running agentcomm-e2e-verification across hosts",
      "Daily 09:00 Tbilisi liveness probe",
      "On user-reported 'agent X is silent' regardless of which host",
    ],
    scope:
      "Two-host liveness: Mac mini + Corsair. The qsa servers and Higgsfield/Otter integrations are out of scope for this skill — they have their own runbooks.",
    prerequisites: [
      "Tailscale up on the controller host",
      "Qoopia health endpoint reachable on both hosts",
      "agent_status MCP tool available in the controller's tool surface",
    ],
    exact_steps: [
      "ping -c 1 corsair via Tailscale name; assert latency < 50ms",
      "ping -c 1 mac-mini via Tailscale name; assert latency < 100ms (WAN OK)",
      "curl /healthz on Qoopia on each host; assert HTTP 200 and body 'ok'",
      "Invoke agent_status MCP tool for each agent slug on each host",
      "Assert each agent_status timestamp is within the last 5 min",
    ],
    verification_gates: [
      "Both pings return 0 packet loss",
      "Both Qoopia /healthz return 200",
      "agent_status returns within 2s for every agent slug",
      "All last-seen timestamps are <= 5 min old",
    ],
    failure_modes: [
      "ping fails: check Tailscale (`tailscale status`) and route via the controller's MagicDNS",
      "Qoopia /healthz returns 503: check shadow_sync queue depth; if deep, the bot may be blocked on conflict resolution",
      "agent_status timestamp is stale: the supervisor process may have died — `touch ~/.ductor/restart-requested` on the affected host",
    ],
    rollback:
      "Liveness check is read-only; nothing to roll back. If the check " +
      "fails, escalate to the per-host repair skill (provider-guard-repair " +
      "for Corsair, headless-mac-bootstrap for Mac mini — Phase 3 work).",
    related_code_paths: [
      "src/services/agent-comm.ts",
      "~/.ductor/agents.json",
    ],
    related_incidents: [
      "phase1-item-2-mac-mini-onboarding — origin of the two-host topology",
    ],
  },
});

// ──────────────────────────────────────────────────────────────────
// 7. claude-code-auth-rescue
// ──────────────────────────────────────────────────────────────────
const skill7 = skillUpsert({
  workspace_id: ws.id,
  slug: "claude-code-auth-rescue",
  title: "Claude Code auth rescue",
  summary:
    "Recover a Claude Code installation whose auth has gone bad " +
    "(401 on every tool call, stale session cookie, or wiped " +
    "credential file). References the Phase 1 provider guard fork " +
    "install pattern.",
  metadata: {
    skill_version: "1.0.0",
    owner_agent: "corsair-main",
    trigger_conditions: [
      "Claude Code returns 401 on every tool call",
      "~/.claude/credentials.json is missing or 0 bytes",
      "Claude Code shows 'session expired' on every prompt",
    ],
    scope:
      "Claude Code CLI installation only. Does not cover Anthropic provider auth at the Qoopia service layer — see corsair-provider-guard-repair for that.",
    prerequisites: [
      "ssh access to the affected host",
      "Vaultwarden retrieval available for the Anthropic provider entry",
      "Phase 1 provider guard fork install present at /usr/local/bin/claude-guard",
    ],
    exact_steps: [
      "Stop the Claude Code daemon if running (`pkill -f claude-code` after confirming no active session)",
      "Move the existing ~/.claude/credentials.json aside to ~/.claude/credentials.json.broken-<UTC>",
      "Run /usr/local/bin/claude-guard --re-auth (Phase 1 fork install) — fetches the provider token via the vault wrapper and writes a fresh credentials.json",
      "Verify ownership: chmod 600 ~/.claude/credentials.json",
      "Run `claude --version` and `claude doctor` (if available) to confirm the install picks up the new creds",
      "Run a single scratch tool call to validate end-to-end",
    ],
    verification_gates: [
      "credentials.json exists, is 600, and has size > 0",
      "claude doctor (or first scratch prompt) returns no 401",
      "No token value appears in bash history or in any log file from the rescue",
    ],
    failure_modes: [
      "claude-guard --re-auth returns 'no upstream session': the workspace's provider entry is empty in Vaultwarden — escalate to operator before retrying",
      "credentials.json written but Claude Code still 401s: check the host clock — Anthropic auth is time-sensitive; `timedatectl status` and resync NTP",
      "claude-guard binary missing: the Phase 1 fork install was overwritten — reinstall from $QOOPIA_ROOT/scripts/install-claude-guard.sh",
    ],
    rollback:
      "Move credentials.json.broken-<UTC> back into place: " +
      "`mv ~/.claude/credentials.json.broken-<UTC> ~/.claude/credentials.json`. " +
      "Re-chmod 600. This restores the pre-rescue (still-broken) state so " +
      "no other party gets a half-rescued session.",
    related_code_paths: [
      "/usr/local/bin/claude-guard",
      "$QOOPIA_ROOT/scripts/install-claude-guard.sh",
      "~/.claude/credentials.json",
    ],
    related_incidents: [
      "phase1-item-7-claude-code-auth-loss — origin",
    ],
  },
});

const seeded = [skill1, skill2, skill3, skill4, skill5, skill6, skill7];

console.log("phase2-item-e seed complete:");
console.log(`  workspace: ${ws.id} (${ws.slug})`);
console.log(`  agentcomm-protocol: ${acProtocol.id}`);
for (const s of seeded) {
  console.log(`  skill: ${s.slug} -> ${s.id} (created=${s.created})`);
}

// Render the first runbook so the smoke output proves the renderer
// produces valid markdown end-to-end.
const sample = skillRenderRunbook({
  workspace_id: ws.id,
  slug: "agentcomm-e2e-verification",
});
console.log(`  runbook bytes: ${sample.markdown.length}`);
console.log(`  runbook last_tested: ${sample.last_tested ?? "never"}`);
console.log("done.");
