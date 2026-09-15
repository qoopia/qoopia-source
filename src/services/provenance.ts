import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { getNote } from "./notes.ts";
import { assertWriteScope, isAdmin } from "../auth/principal.ts";

export const PROVENANCE_SOURCE_KINDS = [
  "session_message",
  "file",
  "activity",
  "note",
  "agentcomm_message",
  "manual",
] as const;

export type ProvenanceSourceKind = (typeof PROVENANCE_SOURCE_KINDS)[number];

interface ProvenanceRow {
  id: string;
  workspace_id: string;
  note_id: string;
  source_kind: ProvenanceSourceKind;
  source_id: string;
  source_locator: string | null;
  source_hash: string;
  confidence: number;
  created_by_agent_id: string;
  metadata: string;
  created_at: string;
}
const SHA256_RE = /^[0-9a-f]{64}$/;



export function normalizeProvenanceFragment(fragment: string): string {
  return fragment.replace(/\r\n?/g, "\n").trim().replace(/[\t ]+/g, " ");
}

export function hashProvenanceFragment(fragment: string): string {
  return createHash("sha256")
    .update(normalizeProvenanceFragment(fragment), "utf8")
    .digest("hex");
}

function sourceVisible(
  auth: AuthContext,
  sourceKind: ProvenanceSourceKind,
  sourceId: string,
): boolean {
  const workspaceId = auth.workspace_id;
  switch (sourceKind) {
    case "session_message": {
      if (!/^\d+$/.test(sourceId)) return false;
      const row = db.prepare(
        `SELECT agent_id FROM session_messages WHERE workspace_id = ? AND id = ?`,
      ).get(workspaceId, Number(sourceId)) as { agent_id: string | null } | undefined;
      return !!row && (row.agent_id === auth.agent_id || isAdmin(auth));
    }
    case "file":
      return !!db.prepare(
        `SELECT 1 FROM files WHERE workspace_id = ? AND id = ?`,
      ).get(workspaceId, sourceId);
    case "activity": {
      const row = db.prepare(
        `SELECT agent_id, visibility FROM activity WHERE workspace_id = ? AND id = ?`,
      ).get(workspaceId, sourceId) as
        | { agent_id: string | null; visibility: string }
        | undefined;
      return !!row &&
        (row.visibility === "workspace" || row.agent_id === auth.agent_id || isAdmin(auth));
    }
    case "note":
      try {
        getNote(workspaceId, sourceId, auth.agent_id, isAdmin(auth));
        return true;
      } catch {
        return false;
      }
    case "agentcomm_message": {
      const row = db.prepare(
        `SELECT sender_agent_id, recipient_agent_id
           FROM agent_comm_messages WHERE workspace_id = ? AND id = ?`,
      ).get(workspaceId, sourceId) as
        | { sender_agent_id: string; recipient_agent_id: string }
        | undefined;
      return !!row &&
        (row.sender_agent_id === auth.agent_id ||
          row.recipient_agent_id === auth.agent_id ||
          isAdmin(auth));
    }
    case "manual":
      // Manual provenance has no independently readable source object. Its
      // visibility is therefore exactly the destination note visibility,
      // which callers validate before reaching this helper.
      return true;
  }
}

function out(row: ProvenanceRow) {
  return {
    ...row,
    metadata: safeJsonParse(row.metadata, {} as Record<string, unknown>),
  };
}

/** Store only a digest and opaque source reference; raw evidence is never persisted. */
export function createNoteProvenance(input: {
  auth: AuthContext;
  note_id: string;
  source_kind: ProvenanceSourceKind;
  source_id: string;
  source_hash: string;
  source_locator?: string | null;
  confidence: number;
  metadata?: Record<string, unknown>;
}) {
  assertWriteScope(input.auth);
  if (!(PROVENANCE_SOURCE_KINDS as readonly string[]).includes(input.source_kind)) {
    throw new QoopiaError("INVALID_INPUT", "unsupported provenance source_kind");
  }
  if (!input.source_id || input.source_id.length > 512) {
    throw new QoopiaError("INVALID_INPUT", "source_id must contain 1..512 characters");
  }
  if (!SHA256_RE.test(input.source_hash)) {
    throw new QoopiaError("INVALID_INPUT", "source_hash must be lowercase SHA-256");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new QoopiaError("INVALID_INPUT", "confidence must be between 0 and 1");
  }
  if (input.source_locator && input.source_locator.length > 2048) {
    throw new QoopiaError("SIZE_LIMIT", "source_locator exceeds 2048 characters");
  }
  if (input.source_locator) assertNoSecrets(input.source_locator, "provenance.source_locator");
  if (input.metadata) assertNoSecrets(JSON.stringify(input.metadata), "provenance.metadata");

  getNote(
    input.auth.workspace_id,
    input.note_id,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  if (!sourceVisible(input.auth, input.source_kind, input.source_id)) {
    // NOT_FOUND avoids disclosing cross-workspace/private source existence.
    throw new QoopiaError("NOT_FOUND", "provenance source not found");
  }

  return db.transaction(() => {
    getNote(
      input.auth.workspace_id,
      input.note_id,
      input.auth.agent_id,
      isAdmin(input.auth),
    );
    if (!sourceVisible(input.auth, input.source_kind, input.source_id)) {
      throw new QoopiaError("NOT_FOUND", "provenance source not found");
    }
    const existing = db.prepare(
      `SELECT * FROM note_provenance
        WHERE workspace_id = ? AND note_id = ? AND source_kind = ? AND source_id = ?`,
    ).get(
      input.auth.workspace_id,
      input.note_id,
      input.source_kind,
      input.source_id,
    ) as ProvenanceRow | undefined;
    if (existing) {
      if (
        existing.source_hash !== input.source_hash ||
        existing.confidence !== input.confidence ||
        existing.source_locator !== (input.source_locator ?? null)
      ) {
        throw new QoopiaError("CONFLICT", "provenance idempotency key has different content");
      }
      return { created: false, provenance: out(existing) };
    }

    const id = ulid();
    db.prepare(
      `INSERT INTO note_provenance
         (id, workspace_id, note_id, source_kind, source_id, source_locator,
          source_hash, confidence, created_by_agent_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.auth.workspace_id,
      input.note_id,
      input.source_kind,
      input.source_id,
      input.source_locator ?? null,
      input.source_hash,
      input.confidence,
      input.auth.agent_id,
      JSON.stringify(input.metadata ?? {}),
      nowIso(),
    );
    const row = db.prepare(`SELECT * FROM note_provenance WHERE id = ?`).get(id) as ProvenanceRow;
    return { created: true, provenance: out(row) };
  })();
}

/**
 * Resolve provenance metadata only. This intentionally returns no source body
 * and silently omits rows whose underlying source is not visible to caller.
 */
export function resolveNoteProvenance(input: { auth: AuthContext; note_id: string }) {
  getNote(
    input.auth.workspace_id,
    input.note_id,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  const rows = db.prepare(
    `SELECT * FROM note_provenance
      WHERE workspace_id = ? AND note_id = ?
      ORDER BY created_at ASC, id ASC`,
  ).all(input.auth.workspace_id, input.note_id) as ProvenanceRow[];
  const visible = rows.filter((row) =>
    sourceVisible(input.auth, row.source_kind, row.source_id)
  );
  return {
    items: visible.map(out),
    count: visible.length,
    max_confidence:
      visible.length === 0
        ? null
        : Math.max(...visible.map((row) => row.confidence)),
  };
}

