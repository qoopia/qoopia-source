/**
 * Phase 2 Item F — MAINMEMORY → entity pages migration runner.
 *
 * SoT rule (Phase 0 decisions §Q10, locked in plan note
 * 01KSC0E9F1WFWJMSP58KS34H2A): Qoopia entity_pages are the source of
 * truth for durable facts about persons, agents, machines, services,
 * projects, protocols, and knowledge topics. Per-agent
 * `memory_system/MAINMEMORY.md` is an ephemeral cache rehydrated at
 * session start via the refresh hook (mainmemory_refresh.ts).
 *
 * This one-shot tool:
 *   1. Parses a MAINMEMORY.md into H2 sections (plus pre-H2 intro).
 *   2. Classifies each section as durable / ephemeral / stale by header
 *      keyword heuristic.
 *   3. In --apply mode: upserts every durable section into entity_pages
 *      (idempotent on workspace_id + slug) and writes back a stub
 *      MAINMEMORY.md whose body is (a) the SoT reference header listing
 *      migrated slugs and (b) the verbatim ephemeral sections that
 *      survive as session-scoped state.
 *   4. Default DRY-RUN: prints the classification table + per-section
 *      target slugs + entity_upsert simulation counts. No DB writes.
 *      Production MAINMEMORY MUST NOT be touched without --apply.
 *
 * Provenance: every migrated entity carries
 *   metadata.migrated_from   = "MAINMEMORY.md"
 *   metadata.migrated_at     = ISO ms timestamp at run start
 *   metadata.original_section = the original H2 header text
 *   metadata.source_path     = absolute path of the source file
 * so the migration is auditable from the entity row alone.
 *
 * SHARED KNOWLEDGE blocks (delimited by `--- SHARED KNOWLEDGE START ---`
 * / `--- SHARED KNOWLEDGE END ---`) are owned by edit_shared_knowledge.py
 * and the Supervisor sync — this tool ignores them entirely.
 *
 * Usage (inside qoopia-corsair container):
 *
 *   bun run /app/scripts/mainmemory_migrate.ts \
 *     --source=/path/to/MAINMEMORY.md \
 *     --workspace-slug=default \
 *     [--apply] \
 *     [--out=/path/to/MAINMEMORY.md.stub]
 *
 * --out defaults to the source path; --apply controls whether DB +
 * filesystem writes happen. Without --apply both are no-ops.
 *
 * Hard rule (per task brief): NEVER --apply against
 * /home/askhat/.ductor-corsairmain/workspace/memory_system/MAINMEMORY.md
 * from this PR. Only synthetic /tmp inputs in tests.
 */
import fs from "node:fs";
import path from "node:path";

import { db } from "../src/db/connection.ts";
import {
  upsertEntity,
  type EntityType,
  type UpsertResult,
} from "../src/services/entities.ts";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface ParsedSection {
  /** H2 header text without the leading `## ` marker. `null` = pre-H2 intro. */
  header: string | null;
  /** Section body excluding its own header line; trailing newline trimmed. */
  body: string;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed, inclusive
}

/**
 * Split a MAINMEMORY.md into ordered sections by `## ` H2 boundaries.
 *
 * The fenced SHARED KNOWLEDGE block (delimited by
 * `--- SHARED KNOWLEDGE START ---` / `--- SHARED KNOWLEDGE END ---`) is
 * skipped during section accumulation but its lines remain in the
 * original file — the caller (writeStub) handles preservation
 * separately.
 */
export function parseMainmemory(text: string): ParsedSection[] {
  const lines = text.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let inShared = false;
  let cur: ParsedSection | null = null;
  let preH2Body: string[] = [];
  let preH2Started = false;

  const flush = (endLine: number): void => {
    if (cur) {
      cur.endLine = endLine;
      cur.body = cur.body.replace(/\n+$/, "");
      sections.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("--- SHARED KNOWLEDGE START ---")) {
      inShared = true;
      continue;
    }
    if (line.startsWith("--- SHARED KNOWLEDGE END ---")) {
      inShared = false;
      continue;
    }
    if (inShared) continue;

    if (line.startsWith("## ")) {
      // Boundary: flush any open H2 section AND, on first encounter, also
      // flush the pre-H2 intro accumulated so far.
      if (cur) {
        flush(i); // previous H2 ends at line i (0-indexed before this header)
      } else if (preH2Started && !sections.length) {
        const intro: ParsedSection = {
          header: null,
          body: preH2Body.join("\n").replace(/\n+$/, ""),
          startLine: 1,
          endLine: i,
        };
        if (intro.body.trim().length > 0) sections.push(intro);
        preH2Started = false;
      }
      cur = {
        header: line.slice(3).trim(),
        body: "",
        startLine: i + 1, // 1-indexed
        endLine: i + 1,
      };
      continue;
    }

    if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    } else {
      preH2Body.push(line);
      preH2Started = true;
    }
  }

  if (cur) {
    flush(lines.length);
  } else if (preH2Started && !sections.length) {
    const intro: ParsedSection = {
      header: null,
      body: preH2Body.join("\n").replace(/\n+$/, ""),
      startLine: 1,
      endLine: lines.length,
    };
    if (intro.body.trim().length > 0) sections.push(intro);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Bucket = "durable" | "ephemeral" | "stale";

export interface Classification {
  bucket: Bucket;
  reason: string;
}

/**
 * Header keyword → bucket. Order matters: first match wins. Lowercase
 * substring match against the H2 header (or "<intro>" for the pre-H2
 * persona block).
 *
 * Tuned for corsair-main's MAINMEMORY shape; conservative — anything
 * unrecognised falls through to "ephemeral" so we never silently
 * migrate ambiguous prose to entity pages.
 */
const STALE_PATTERNS: Array<{ kw: string; reason: string }> = [
  { kw: "deprecated", reason: "explicit deprecated marker" },
  { kw: "obsolete", reason: "explicit obsolete marker" },
  { kw: "expired", reason: "explicit expired marker" },
];

const EPHEMERAL_PATTERNS: Array<{ kw: string; reason: string }> = [
  { kw: "current task", reason: "live task state" },
  { kw: "in progress", reason: "live progress state" },
  { kw: "wave ", reason: "phase-wave session state" },
  { kw: "round ", reason: "review-round session state" },
  { kw: "recent ", reason: "recent-events log" },
  { kw: "upgrade plan", reason: "rolling plan state" },
  { kw: "phase 2 score", reason: "rolling phase tally" },
  { kw: " — state", reason: "explicit '— state' marker in header" },
  { kw: "state с ", reason: "Russian 'state с' marker" },
];

const DURABLE_PATTERNS: Array<{
  kw: string;
  reason: string;
  type: EntityType;
}> = [
  { kw: "<intro>", reason: "agent persona / system identity", type: "agent" },
  { kw: "bootstrap facts", reason: "bootstrap identity facts", type: "knowledge" },
  { kw: "runtime auth", reason: "runtime auth configuration", type: "knowledge" },
  { kw: "production layout", reason: "service topology", type: "service" },
  { kw: "baseline", reason: "host baseline facts", type: "machine" },
  { kw: "lan map", reason: "host network topology", type: "machine" },
  { kw: "migration strategy", reason: "long-running migration plan", type: "project" },
  { kw: "reranker", reason: "service stack", type: "service" },
  { kw: "agent-to-agent comms", reason: "inter-agent protocol", type: "protocol" },
  { kw: "agentcomm", reason: "AgentComm protocol surface", type: "protocol" },
  { kw: "memory protocol", reason: "agent memory protocol", type: "protocol" },
  { kw: "split-brain", reason: "split-brain semantics knowledge", type: "knowledge" },
  { kw: "github access", reason: "GitHub access facts", type: "knowledge" },
  { kw: "vault role", reason: "vault-keeper role definition", type: "agent" },
  { kw: "machines", reason: "machine inventory", type: "machine" },
  { kw: "services", reason: "service inventory", type: "service" },
];

/**
 * Marker emitted by applyMigration() into the stub file. If a pre-H2
 * intro body starts with this, we are looking at a stub — its content
 * is the SoT pointer, not the agent persona, and MUST NOT be re-migrated.
 */
export const STUB_HEADER_PREFIX =
  "# Cache file — refresh from Qoopia entity pages";

export function classifySection(s: ParsedSection): Classification {
  // Stub-detection: a pre-H2 body that opens with the SoT cache marker
  // came from a prior migration run. Re-classifying it as ephemeral
  // keeps re-runs idempotent — the persona entity stays untouched.
  if (s.header === null && s.body.trimStart().startsWith(STUB_HEADER_PREFIX)) {
    return {
      bucket: "ephemeral",
      reason: "stub SoT marker — already migrated",
    };
  }

  const headerLc = (s.header ?? "<intro>").toLowerCase();

  for (const p of STALE_PATTERNS) {
    if (headerLc.includes(p.kw)) return { bucket: "stale", reason: p.reason };
  }
  for (const p of EPHEMERAL_PATTERNS) {
    if (headerLc.includes(p.kw))
      return { bucket: "ephemeral", reason: p.reason };
  }
  for (const p of DURABLE_PATTERNS) {
    if (headerLc.includes(p.kw)) return { bucket: "durable", reason: p.reason };
  }

  return {
    bucket: "ephemeral",
    reason: "default — header did not match any durable pattern",
  };
}

/**
 * Look up the durable entity type for a header that classified as
 * durable. Returns null if the header didn't match a durable pattern.
 */
export function durableEntityType(
  s: ParsedSection,
): { type: EntityType; reason: string } | null {
  const headerLc = (s.header ?? "<intro>").toLowerCase();
  for (const p of DURABLE_PATTERNS) {
    if (headerLc.includes(p.kw)) return { type: p.type, reason: p.reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slug + title derivation
// ---------------------------------------------------------------------------

const SLUG_MAX = 200;

/** Header → URL-safe slug, deterministic so re-runs hit the same entity. */
export function deriveSlug(header: string | null): string {
  if (!header) return "corsair-main-persona";
  // Strip after first em-dash, en-dash, hyphen-with-spaces, or parenthesis
  // to lose date qualifiers like "(2026-05-22, confirmed by Askhat)".
  let h = header.split(/[—–(]/, 1)[0]!.trim();
  // Lowercase, replace non-alphanumerics with dash, collapse, trim.
  h = h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (h.length === 0) {
    // Fallback: hash-like slug from the full header
    h = "section-" + Buffer.from(header).toString("hex").slice(0, 16);
  }
  if (h.length > SLUG_MAX) h = h.slice(0, SLUG_MAX).replace(/-+$/, "");
  return h;
}

/** Header → entity title. Empty/null header falls back to the persona title. */
export function deriveTitle(header: string | null): string {
  if (!header) return "corsair-main — agent persona (migrated from MAINMEMORY)";
  return header.length <= 300 ? header : header.slice(0, 297) + "...";
}

// ---------------------------------------------------------------------------
// Planning + execution
// ---------------------------------------------------------------------------

export interface PlanEntry {
  section: ParsedSection;
  classification: Classification;
  slug?: string;
  entityType?: EntityType;
  title?: string;
}

export interface Plan {
  entries: PlanEntry[];
  counts: { durable: number; ephemeral: number; stale: number };
}

export function planMigration(sections: ParsedSection[]): Plan {
  const counts = { durable: 0, ephemeral: 0, stale: 0 };
  const entries: PlanEntry[] = [];
  for (const s of sections) {
    const cls = classifySection(s);
    counts[cls.bucket]++;
    if (cls.bucket === "durable") {
      const typeInfo = durableEntityType(s);
      entries.push({
        section: s,
        classification: cls,
        slug: deriveSlug(s.header),
        entityType: typeInfo?.type ?? "knowledge",
        title: deriveTitle(s.header),
      });
    } else {
      entries.push({ section: s, classification: cls });
    }
  }
  return { entries, counts };
}

export interface ApplyResult {
  upsertResults: Array<{
    slug: string;
    created: boolean;
    skipped: boolean;
    reason?: string;
  }>;
  stubBytes: number;
  stubPath: string;
}

export interface ApplyOptions {
  workspaceId: string;
  sourcePath: string;
  outPath: string;
  migratedAt: string;
}

/**
 * Apply a planned migration: upsert every durable section into
 * entity_pages, then write a stub MAINMEMORY.md preserving the
 * ephemeral-bucket sections verbatim under the SoT reference header.
 *
 * Idempotent: re-running on a stubbed MAINMEMORY produces zero durable
 * sections, zero entity upserts (the stub header is not durable), and a
 * stub identical to the input modulo the migrated_at timestamp inside
 * the SoT header line.
 */
export function applyMigration(plan: Plan, opts: ApplyOptions): ApplyResult {
  const upsertResults: ApplyResult["upsertResults"] = [];
  const migratedSlugs: string[] = [];

  for (const e of plan.entries) {
    if (e.classification.bucket !== "durable") continue;
    if (!e.slug || !e.entityType || !e.title) continue;

    const summary = e.section.body;
    const metadata = {
      migrated_from: "MAINMEMORY.md",
      migrated_at: opts.migratedAt,
      original_section: e.section.header ?? "<intro>",
      source_path: opts.sourcePath,
      original_start_line: e.section.startLine,
      original_end_line: e.section.endLine,
    };

    let res: UpsertResult;
    try {
      res = upsertEntity({
        workspace_id: opts.workspaceId,
        type: e.entityType,
        slug: e.slug,
        title: e.title,
        summary: summary.length > 0 ? summary : null,
        metadata,
      });
    } catch (err) {
      upsertResults.push({
        slug: e.slug,
        created: false,
        skipped: true,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    upsertResults.push({
      slug: res.slug,
      created: res.created,
      skipped: false,
    });
    migratedSlugs.push(res.slug);
  }

  // Build the stub body.
  const stubLines: string[] = [];
  stubLines.push(
    `# Cache file — refresh from Qoopia entity pages at session start. See entity_page slugs: [${migratedSlugs.join(", ")}]`,
  );
  stubLines.push("");
  stubLines.push(
    `<!-- Migrated by mainmemory_migrate.ts at ${opts.migratedAt}. Durable facts live in Qoopia entity_pages (workspace=${opts.workspaceId}). Rehydrate via scripts/mainmemory_refresh.ts. -->`,
  );
  stubLines.push("");
  // Carry the ephemeral sections forward verbatim.
  const kept = plan.entries.filter(
    (e) => e.classification.bucket === "ephemeral",
  );
  for (const e of kept) {
    if (e.section.header) {
      stubLines.push(`## ${e.section.header}`);
    }
    if (e.section.body.trim().length > 0) {
      stubLines.push(e.section.body);
    }
    stubLines.push("");
  }
  const stubText = stubLines.join("\n").replace(/\n+$/, "") + "\n";
  fs.writeFileSync(opts.outPath, stubText, { mode: 0o600 });
  return {
    upsertResults,
    stubBytes: Buffer.byteLength(stubText, "utf8"),
    stubPath: opts.outPath,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface CliArgs {
  source: string;
  workspaceSlug: string;
  out: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { apply: false };
  for (const raw of argv) {
    if (raw === "--apply") {
      args.apply = true;
    } else if (raw.startsWith("--source=")) {
      args.source = raw.slice("--source=".length);
    } else if (raw.startsWith("--workspace-slug=")) {
      args.workspaceSlug = raw.slice("--workspace-slug=".length);
    } else if (raw.startsWith("--out=")) {
      args.out = raw.slice("--out=".length);
    }
  }
  if (!args.source) {
    throw new Error("--source=<path> is required");
  }
  if (!args.workspaceSlug) {
    throw new Error("--workspace-slug=<slug> is required");
  }
  args.out = args.out ?? args.source;
  return args as CliArgs;
}

function resolveWorkspaceId(slug: string): string {
  const row = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ? LIMIT 1`)
    .get(slug) as { id: string } | undefined;
  if (!row) {
    throw new Error(
      `workspace slug '${slug}' not found; create it with admin tooling first`,
    );
  }
  return row.id;
}

export interface RunResult {
  mode: "dry-run" | "apply";
  source: string;
  workspaceSlug: string;
  workspaceId: string;
  counts: Plan["counts"];
  durable: Array<{ slug: string; type: EntityType; title: string }>;
  ephemeralHeaders: string[];
  staleHeaders: string[];
  apply?: ApplyResult;
}

export function run(argv: string[]): RunResult {
  const args = parseArgs(argv);
  const text = fs.readFileSync(args.source, "utf8");
  const sections = parseMainmemory(text);
  const plan = planMigration(sections);
  const workspaceId = resolveWorkspaceId(args.workspaceSlug);
  const migratedAt = new Date().toISOString();

  const durable = plan.entries
    .filter((e) => e.classification.bucket === "durable")
    .map((e) => ({
      slug: e.slug!,
      type: e.entityType!,
      title: e.title!,
    }));
  const ephemeralHeaders = plan.entries
    .filter((e) => e.classification.bucket === "ephemeral")
    .map((e) => e.section.header ?? "<intro>");
  const staleHeaders = plan.entries
    .filter((e) => e.classification.bucket === "stale")
    .map((e) => e.section.header ?? "<intro>");

  const result: RunResult = {
    mode: args.apply ? "apply" : "dry-run",
    source: path.resolve(args.source),
    workspaceSlug: args.workspaceSlug,
    workspaceId,
    counts: plan.counts,
    durable,
    ephemeralHeaders,
    staleHeaders,
  };

  if (args.apply) {
    result.apply = applyMigration(plan, {
      workspaceId,
      sourcePath: path.resolve(args.source),
      outPath: path.resolve(args.out),
      migratedAt,
    });
  }

  return result;
}

if (import.meta.main) {
  const out = run(process.argv.slice(2));
  console.log(JSON.stringify(out, null, 2));
}
