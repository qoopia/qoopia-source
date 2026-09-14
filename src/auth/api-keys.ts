import crypto from "node:crypto";
import { db } from "../db/connection.ts";
import { nowIso } from "../utils/errors.ts";
import { isReadOnlyInstance } from "../utils/instance-role.ts";

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function generateApiKey(): string {
  // 32 random bytes, base64url, prefixed with "q_"
  const raw = crypto.randomBytes(32);
  const b64 = raw.toString("base64url");
  return `q_${b64}`;
}

export interface AgentRecord {
  id: string;
  workspace_id: string;
  name: string;
  type: "standard" | "claude-privileged" | string;
  api_key_hash: string;
  active: number;
  last_seen: string | null;
  metadata: string;
  created_at: string;
  // QSA-F / ADR-016: per-agent MCP tool risk profile. NOT NULL DEFAULT 'full'
  // in the schema; older rows that pre-date migration 010 receive 'full' on
  // upgrade. Unknown / null values are coerced to 'read-only' fail-closed in
  // src/mcp/tools.ts, so this field's runtime type is "trust the DB CHECK
  // constraint or fail safer".
  tool_profile?: string | null;
  policy_epoch?: number;
  session_version?: number;
  authority_profile?: string;
  legacy_skill_access?: number;
}

export function verifyApiKey(token: string): AgentRecord | null {
  const hash = sha256Hex(token);
  const row = db
    .prepare(
      `SELECT * FROM agents WHERE api_key_hash = ? AND active = 1 LIMIT 1`,
    )
    .get(hash) as AgentRecord | undefined;
  if (!row) return null;

  // Authentication is a read flow on legacy exports. Suppress telemetry
  // explicitly instead of relying on the DB invariant to throw on every call.
  if (!isReadOnlyInstance()) {
    try {
      db.prepare(`UPDATE agents SET last_seen = ? WHERE id = ?`).run(
        nowIso(),
        row.id,
      );
    } catch {}
  }

  return row;
}
