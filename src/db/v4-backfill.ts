import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { assertV4Schema, computeLogicalDatabaseHash } from "./v4-migrations.ts";

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type LegacyField = "supersedes" | "superseded_by";

interface NoteEnvelope {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface ExistingRelation {
  workspace_id: string;
  source_note_id: string;
  target_note_id: string;
}

interface MutableProposal {
  workspace_id: string;
  source_note_id: string;
  target_note_id: string;
  created_by_agent_id: string | null;
  created_at: string | null;
  evidence: Set<string>;
  blocked: Set<string>;
  existing: boolean;
}

export interface BackfillIssue {
  code: string;
  workspace_id?: string;
  note_ids: string[];
  field?: LegacyField;
}

export interface RelationProposal {
  id: string;
  workspace_id: string;
  source_note_id: string;
  target_note_id: string;
  created_by_agent_id: string | null;
  created_at: string | null;
  evidence: string[];
  disposition: "eligible" | "existing" | "blocked";
  block_reasons: string[];
}

export interface RelationBackfillPlan {
  schema_version: 32;
  counts: {
    notes_scanned: number;
    metadata_references: number;
    proposals: number;
    eligible: number;
    existing: number;
    blocked: number;
    issues: number;
  };
  issue_counts: Record<string, number>;
  issues: BackfillIssue[];
  proposals: RelationProposal[];
}

export interface BackfillExecutionOptions {
  dryRun?: boolean;
  resumeAfter?: string | null;
  batchSize?: number;
  stopAfter?: number;
  onCheckpoint?: (checkpoint: {
    last_processed_note_id: string;
    processed: number;
    inserted: number;
  }) => void;
}

export interface BackfillExecutionResult {
  mode: "dry-run" | "apply";
  processed: number;
  inserted: number;
  already_present: number;
  interrupted: boolean;
  last_processed_note_id: string | null;
  logical_hash: string;
}

function relationKey(workspaceId: string, sourceId: string, targetId: string): string {
  return `${workspaceId}\u0000${sourceId}\u0000${targetId}`;
}

function noteKey(workspaceId: string, noteId: string): string {
  return `${workspaceId}\u0000${noteId}`;
}

function deterministicUlid(input: string): string {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let output = "";
  for (let index = 0; index < 26; index += 1) {
    output = CROCKFORD32[Number(value & 31n)]! + output;
    value >>= 5n;
  }
  return output;
}

function parseMetadata(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The report carries the note ID only; raw metadata is never emitted.
  }
  return null;
}

function readReference(
  note: NoteEnvelope,
  field: LegacyField,
): { present: false } | { present: true; valid: false } | {
  present: true;
  valid: true;
  value: string;
} {
  if (!note.metadata || !(field in note.metadata)) return { present: false };
  const value = note.metadata[field];
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    return { present: true, valid: false };
  }
  return { present: true, valid: true, value };
}

function hasPath(
  start: string,
  goal: string,
  adjacency: Map<string, Set<string>>,
): boolean {
  const pending = [start];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

function addIssue(
  issues: Map<string, BackfillIssue>,
  issue: BackfillIssue,
): void {
  const normalized = {
    ...issue,
    note_ids: [...new Set(issue.note_ids)].sort(),
  };
  const key = JSON.stringify(normalized);
  issues.set(key, normalized);
}

function validateBatch(db: Database): void {
  const quick = db.query("PRAGMA quick_check").all() as Array<{
    quick_check: string;
  }>;
  if (quick.length !== 1 || quick[0]?.quick_check !== "ok") {
    throw new Error(`Backfill quick_check failed`);
  }
  const foreignKeys = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(
      `Backfill foreign_key_check failed with ${foreignKeys.length} violation(s)`,
    );
  }
}

export function planRelationBackfill(db: Database): RelationBackfillPlan {
  assertV4Schema(db);
  const rows = db
    .query(
      `SELECT id, workspace_id, agent_id, metadata, created_at, updated_at
       FROM notes
       WHERE deleted_at IS NULL
       ORDER BY workspace_id, id`,
    )
    .all() as Array<{
      id: string;
      workspace_id: string;
      agent_id: string | null;
      metadata: string;
      created_at: string;
      updated_at: string;
    }>;
  const notes: NoteEnvelope[] = rows.map((row) => ({
    ...row,
    metadata: parseMetadata(row.metadata),
  }));
  const byWorkspaceId = new Map(notes.map((note) => [
    noteKey(note.workspace_id, note.id),
    note,
  ]));
  const byId = new Map(notes.map((note) => [note.id, note]));
  const agents = new Set(
    (db.query("SELECT id, workspace_id FROM agents").all() as Array<{
      id: string;
      workspace_id: string;
    }>).map((agent) => noteKey(agent.workspace_id, agent.id)),
  );
  const existing = db
    .query(
      `SELECT workspace_id, source_note_id, target_note_id
       FROM note_relations
       WHERE relation_type = 'supersedes'`,
    )
    .all() as ExistingRelation[];
  const existingKeys = new Set(
    existing.map((relation) =>
      relationKey(
        relation.workspace_id,
        relation.source_note_id,
        relation.target_note_id,
      )
    ),
  );

  const proposals = new Map<string, MutableProposal>();
  const issues = new Map<string, BackfillIssue>();
  let metadataReferences = 0;

  const propose = (
    workspaceId: string,
    sourceId: string,
    targetId: string,
    evidence: string,
  ) => {
    const key = relationKey(workspaceId, sourceId, targetId);
    let proposal = proposals.get(key);
    if (!proposal) {
      const source = byWorkspaceId.get(noteKey(workspaceId, sourceId));
      proposal = {
        workspace_id: workspaceId,
        source_note_id: sourceId,
        target_note_id: targetId,
        created_by_agent_id: source?.agent_id ?? null,
        created_at: source?.updated_at || source?.created_at || null,
        evidence: new Set(),
        blocked: new Set(),
        existing: existingKeys.has(key),
      };
      proposals.set(key, proposal);
    }
    proposal.evidence.add(evidence);
  };

  for (const note of notes) {
    if (!note.metadata) {
      addIssue(issues, {
        code: "invalid_metadata_json",
        workspace_id: note.workspace_id,
        note_ids: [note.id],
      });
      continue;
    }
    const supersedes = readReference(note, "supersedes");
    if (supersedes.present) {
      metadataReferences += 1;
      if (!supersedes.valid) {
        addIssue(issues, {
          code: "malformed_reference",
          workspace_id: note.workspace_id,
          note_ids: [note.id],
          field: "supersedes",
        });
      } else {
        propose(note.workspace_id, note.id, supersedes.value, "source.supersedes");
      }
    }
    const supersededBy = readReference(note, "superseded_by");
    if (supersededBy.present) {
      metadataReferences += 1;
      if (!supersededBy.valid) {
        addIssue(issues, {
          code: "malformed_reference",
          workspace_id: note.workspace_id,
          note_ids: [note.id],
          field: "superseded_by",
        });
      } else {
        propose(
          note.workspace_id,
          supersededBy.value,
          note.id,
          "target.superseded_by",
        );
      }
    }
  }

  for (const proposal of proposals.values()) {
    const source = byWorkspaceId.get(
      noteKey(proposal.workspace_id, proposal.source_note_id),
    );
    const target = byWorkspaceId.get(
      noteKey(proposal.workspace_id, proposal.target_note_id),
    );
    if (proposal.source_note_id === proposal.target_note_id) {
      proposal.blocked.add("self_relation");
      addIssue(issues, {
        code: "self_relation",
        workspace_id: proposal.workspace_id,
        note_ids: [proposal.source_note_id],
      });
    }
    if (!source) {
      const other = byId.get(proposal.source_note_id);
      const code = other ? "cross_workspace_reference" : "orphan_reference";
      proposal.blocked.add(code);
      addIssue(issues, {
        code,
        workspace_id: proposal.workspace_id,
        note_ids: [proposal.source_note_id, proposal.target_note_id],
      });
    }
    if (!target) {
      const other = byId.get(proposal.target_note_id);
      const code = other ? "cross_workspace_reference" : "orphan_reference";
      proposal.blocked.add(code);
      addIssue(issues, {
        code,
        workspace_id: proposal.workspace_id,
        note_ids: [proposal.source_note_id, proposal.target_note_id],
      });
    }
    if (source &&
      (!source.agent_id ||
        !agents.has(noteKey(proposal.workspace_id, source.agent_id)))) {
      proposal.blocked.add("missing_actor");
      addIssue(issues, {
        code: "missing_actor",
        workspace_id: proposal.workspace_id,
        note_ids: [proposal.source_note_id],
      });
    }
    if (source && target) {
      const sourceMirror = readReference(source, "supersedes");
      const targetMirror = readReference(target, "superseded_by");
      if (sourceMirror.present && sourceMirror.valid &&
        sourceMirror.value !== proposal.target_note_id) {
        proposal.blocked.add("mirror_conflict");
      }
      if (targetMirror.present && targetMirror.valid &&
        targetMirror.value !== proposal.source_note_id) {
        proposal.blocked.add("mirror_conflict");
      }
      if (proposal.blocked.has("mirror_conflict")) {
        addIssue(issues, {
          code: "mirror_conflict",
          workspace_id: proposal.workspace_id,
          note_ids: [proposal.source_note_id, proposal.target_note_id],
        });
      }
    }
  }

  const bySource = new Map<string, MutableProposal[]>();
  for (const proposal of proposals.values()) {
    if (proposal.existing || proposal.blocked.size > 0) continue;
    const key = noteKey(proposal.workspace_id, proposal.source_note_id);
    const group = bySource.get(key) ?? [];
    group.push(proposal);
    bySource.set(key, group);
  }
  for (const group of bySource.values()) {
    if (group.length < 2) continue;
    for (const proposal of group) proposal.blocked.add("multiple_targets");
    addIssue(issues, {
      code: "multiple_targets",
      workspace_id: group[0]!.workspace_id,
      note_ids: [
        group[0]!.source_note_id,
        ...group.map((proposal) => proposal.target_note_id),
      ],
    });
  }

  const adjacencyByWorkspace = new Map<string, Map<string, Set<string>>>();
  const addEdge = (workspaceId: string, sourceId: string, targetId: string) => {
    let adjacency = adjacencyByWorkspace.get(workspaceId);
    if (!adjacency) {
      adjacency = new Map();
      adjacencyByWorkspace.set(workspaceId, adjacency);
    }
    const targets = adjacency.get(sourceId) ?? new Set<string>();
    targets.add(targetId);
    adjacency.set(sourceId, targets);
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
  };
  for (const relation of existing) {
    addEdge(relation.workspace_id, relation.source_note_id, relation.target_note_id);
  }
  for (const proposal of proposals.values()) {
    if (!proposal.existing && proposal.blocked.size === 0) {
      addEdge(
        proposal.workspace_id,
        proposal.source_note_id,
        proposal.target_note_id,
      );
    }
  }

  for (const proposal of proposals.values()) {
    if (proposal.existing || proposal.blocked.size > 0) continue;
    const adjacency = adjacencyByWorkspace.get(proposal.workspace_id)!;
    if (hasPath(proposal.target_note_id, proposal.source_note_id, adjacency)) {
      proposal.blocked.add("cycle");
      addIssue(issues, {
        code: "cycle",
        workspace_id: proposal.workspace_id,
        note_ids: [proposal.source_note_id, proposal.target_note_id],
      });
    }
  }

  // Evaluate heads after cycle candidates have been excluded.
  for (const [workspaceId, initialAdjacency] of adjacencyByWorkspace) {
    const adjacency = new Map<string, Set<string>>();
    const undirected = new Map<string, Set<string>>();
    const connect = (sourceId: string, targetId: string) => {
      const targets = adjacency.get(sourceId) ?? new Set<string>();
      targets.add(targetId);
      adjacency.set(sourceId, targets);
      if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
      const sourceLinks = undirected.get(sourceId) ?? new Set<string>();
      sourceLinks.add(targetId);
      undirected.set(sourceId, sourceLinks);
      const targetLinks = undirected.get(targetId) ?? new Set<string>();
      targetLinks.add(sourceId);
      undirected.set(targetId, targetLinks);
    };
    for (const relation of existing) {
      if (relation.workspace_id === workspaceId) {
        connect(relation.source_note_id, relation.target_note_id);
      }
    }
    for (const proposal of proposals.values()) {
      if (proposal.workspace_id === workspaceId && !proposal.existing &&
        proposal.blocked.size === 0) {
        connect(proposal.source_note_id, proposal.target_note_id);
      }
    }
    const visited = new Set<string>();
    for (const start of undirected.keys()) {
      if (visited.has(start)) continue;
      const component = new Set<string>();
      const pending = [start];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (component.has(current)) continue;
        component.add(current);
        visited.add(current);
        for (const next of undirected.get(current) ?? []) pending.push(next);
      }
      const targets = new Set<string>();
      for (const node of component) {
        for (const target of adjacency.get(node) ?? []) targets.add(target);
      }
      const heads = [...component].filter((node) => !targets.has(node)).sort();
      if (heads.length <= 1) continue;
      addIssue(issues, {
        code: "multiple_heads",
        workspace_id: workspaceId,
        note_ids: heads,
      });
      for (const proposal of proposals.values()) {
        if (proposal.workspace_id === workspaceId && !proposal.existing &&
          component.has(proposal.source_note_id) &&
          component.has(proposal.target_note_id)) {
          proposal.blocked.add("multiple_heads");
        }
      }
    }
  }

  const resultProposals: RelationProposal[] = [...proposals.values()]
    .map((proposal) => ({
      id: deterministicUlid(
        `supersedes\u0000${proposal.workspace_id}\u0000${proposal.source_note_id}\u0000${proposal.target_note_id}`,
      ),
      workspace_id: proposal.workspace_id,
      source_note_id: proposal.source_note_id,
      target_note_id: proposal.target_note_id,
      created_by_agent_id: proposal.created_by_agent_id,
      created_at: proposal.created_at,
      evidence: [...proposal.evidence].sort(),
      disposition: proposal.existing
        ? "existing" as const
        : proposal.blocked.size > 0
          ? "blocked" as const
          : "eligible" as const,
      block_reasons: [...proposal.blocked].sort(),
    }))
    .sort((a, b) =>
      a.source_note_id.localeCompare(b.source_note_id) ||
      a.workspace_id.localeCompare(b.workspace_id) ||
      a.target_note_id.localeCompare(b.target_note_id)
    );
  const resultIssues = [...issues.values()].sort((a, b) =>
    a.code.localeCompare(b.code) ||
    (a.workspace_id ?? "").localeCompare(b.workspace_id ?? "") ||
    a.note_ids.join("\u0000").localeCompare(b.note_ids.join("\u0000"))
  );
  const issueCounts: Record<string, number> = {};
  for (const issue of resultIssues) {
    issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
  }
  return {
    schema_version: 32,
    counts: {
      notes_scanned: notes.length,
      metadata_references: metadataReferences,
      proposals: resultProposals.length,
      eligible: resultProposals.filter((proposal) =>
        proposal.disposition === "eligible"
      ).length,
      existing: resultProposals.filter((proposal) =>
        proposal.disposition === "existing"
      ).length,
      blocked: resultProposals.filter((proposal) =>
        proposal.disposition === "blocked"
      ).length,
      issues: resultIssues.length,
    },
    issue_counts: issueCounts,
    issues: resultIssues,
    proposals: resultProposals,
  };
}

function insertProposal(db: Database, proposal: RelationProposal): number {
  if (!proposal.created_by_agent_id || !proposal.created_at) {
    throw new Error(`Eligible proposal is missing actor/timestamp`);
  }
  return db
    .query(
      `INSERT OR IGNORE INTO note_relations
       (id, workspace_id, source_note_id, target_note_id, relation_type,
        created_by_agent_id, metadata, created_at)
       VALUES (?, ?, ?, ?, 'supersedes', ?, ?, ?)`,
    )
    .run(
      proposal.id,
      proposal.workspace_id,
      proposal.source_note_id,
      proposal.target_note_id,
      proposal.created_by_agent_id,
      JSON.stringify({
        backfill: "v4-legacy-metadata",
        evidence: proposal.evidence,
      }),
      proposal.created_at,
    ).changes;
}

export function executeRelationBackfill(
  db: Database,
  plan: RelationBackfillPlan,
  options: BackfillExecutionOptions = {},
): BackfillExecutionResult {
  assertV4Schema(db);
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error(`Backfill batch size must be an integer in [1, 1000]`);
  }
  if (options.stopAfter !== undefined &&
    (!Number.isInteger(options.stopAfter) || options.stopAfter < 1)) {
    throw new Error(`stopAfter must be a positive integer`);
  }

  let pending = plan.proposals.filter((proposal) =>
    proposal.disposition === "eligible" &&
    (!options.resumeAfter || proposal.source_note_id > options.resumeAfter)
  );
  const totalPending = pending.length;
  if (options.stopAfter !== undefined) {
    pending = pending.slice(0, options.stopAfter);
  }

  let inserted = 0;
  let processed = 0;
  let lastProcessed: string | null = null;

  if (options.dryRun) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const proposal of pending) {
        inserted += insertProposal(db, proposal);
        processed += 1;
        lastProcessed = proposal.source_note_id;
      }
      validateBatch(db);
    } finally {
      db.exec("ROLLBACK");
    }
    return {
      mode: "dry-run",
      processed,
      inserted,
      already_present: processed - inserted,
      interrupted: false,
      last_processed_note_id: lastProcessed,
      logical_hash: computeLogicalDatabaseHash(db),
    };
  }

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    let batchInserted = 0;
    db.transaction(() => {
      for (const proposal of batch) batchInserted += insertProposal(db, proposal);
      validateBatch(db);
    })();
    inserted += batchInserted;
    processed += batch.length;
    lastProcessed = batch.at(-1)?.source_note_id ?? lastProcessed;
    if (lastProcessed) {
      options.onCheckpoint?.({
        last_processed_note_id: lastProcessed,
        processed,
        inserted,
      });
    }
  }

  return {
    mode: "apply",
    processed,
    inserted,
    already_present: processed - inserted,
    interrupted: processed < totalPending,
    last_processed_note_id: lastProcessed,
    logical_hash: computeLogicalDatabaseHash(db),
  };
}
