import fs from "node:fs";

const PRODUCTION_ACTIONS = new Set([
  "backup", "migration", "backfill", "deploy_restart", "rollback", "restore",
  "publish", "token_rotation", "agent_deactivation",
]);
const ACTIONS_WITHOUT_PRIOR_BACKUP = new Set(["backup"]);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(filename: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
}

export function verifyProductionGate(input: {
  go: Record<string, unknown>;
  review: Record<string, unknown>;
  backup?: Record<string, unknown>;
  action: string;
  release_sha: string;
  max_backup_age_minutes?: number;
  now?: Date;
}): { valid: true; action: string; release_sha: string; owner_message_id: string } {
  const now = input.now ?? new Date();
  if (!PRODUCTION_ACTIONS.has(input.action) || !/^[0-9a-f]{40}$/.test(input.release_sha)) {
    throw new Error("production action or exact release SHA is invalid");
  }
  const go = input.go;
  const issuedAt = new Date(String(go.issued_at));
  const expiresAt = new Date(String(go.expires_at));
  if (go.owner !== "Асхат" || go.channel !== "owner-own-channel" || go.scope !== "qoopia-v4-production" ||
      go.action !== input.action || go.release_sha !== input.release_sha || go.go !== true ||
      typeof go.message_id !== "string" || !go.message_id || typeof go.issued_at !== "string" ||
      typeof go.expires_at !== "string" || !Number.isFinite(issuedAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime()) || issuedAt > now || expiresAt <= now || issuedAt >= expiresAt) {
    throw new Error("owner GO artifact is missing, expired, or not bound to this action/release");
  }
  const review = input.review;
  if (review.verdict !== "PASS" || review.provider !== "claude" || review.model !== "claude-fable-5" ||
      review.reviewed_sha !== input.release_sha) {
    throw new Error("independent claude/claude-fable-5 exact-SHA PASS is required");
  }
  const maxAge = input.max_backup_age_minutes ?? 30;
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 24 * 60) {
    throw new Error("backup age window is invalid");
  }
  if (!ACTIONS_WITHOUT_PRIOR_BACKUP.has(input.action)) {
    const backup = input.backup;
    if (!backup || backup.integrity_check !== "ok" || backup.mode !== "0600" ||
        typeof backup.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(backup.sha256) ||
        typeof backup.created_at !== "string") {
      throw new Error("verified 0600 backup artifact is required");
    }
    const backupAt = new Date(backup.created_at as string);
    const age = now.getTime() - backupAt.getTime();
    if (!Number.isFinite(backupAt.getTime()) || age < 0 || age > maxAge * 60_000) {
      throw new Error("backup is outside the allowed age window");
    }
  }
  return { valid: true, action: input.action, release_sha: input.release_sha, owner_message_id: go.message_id as string };
}

export function runGateVerifyCli(): void {
  const goPath = arg("--go");
  const reviewPath = arg("--review");
  const action = arg("--action");
  const releaseSha = arg("--release-sha");
  if (!goPath || !reviewPath || !action || !releaseSha) {
    throw new Error("usage: v4-gate-verify --go JSON --review JSON --action ACTION --release-sha SHA [--backup JSON --max-backup-age-minutes N]");
  }
  const backupPath = arg("--backup");
  const maxAge = arg("--max-backup-age-minutes");
  const result = verifyProductionGate({
    go: readJson(goPath),
    review: readJson(reviewPath),
    backup: backupPath ? readJson(backupPath) : undefined,
    action,
    release_sha: releaseSha,
    max_backup_age_minutes: maxAge ? Number(maxAge) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) runGateVerifyCli();
