/**
 * Phase 2 Item F — session-start MAINMEMORY refresh hook.
 *
 * Companion to mainmemory_migrate.ts. After migration, the per-agent
 * MAINMEMORY.md is a thin SoT pointer; agents rehydrate the durable
 * facts by calling this script at session start and prepending its
 * markdown output to their system prompt.
 *
 * The script reads a newline-delimited slug list (one slug per line,
 * `#`-prefixed lines ignored), looks each one up in the named workspace
 * via the entity_pages service, and prints the concatenated rendered
 * markdown to stdout. Missing slugs produce a single-line warning
 * marker so the agent can detect schema drift without failing the
 * whole refresh.
 *
 * Usage (inside qoopia-corsair container):
 *
 *   bun run /app/scripts/mainmemory_refresh.ts \
 *     --slugs-file=/mnt/agent/mainmemory_refresh_slugs.txt \
 *     --workspace-slug=default \
 *     [--max-bytes=65536]
 *
 * The slugs file path is configurable so host callers can bind-mount
 * ~/.ductor-corsairmain/workspace/memory_system/mainmemory_refresh_slugs.txt
 * (host) onto an in-container path. The default in-container path is
 * /etc/qoopia/mainmemory_refresh_slugs.txt.
 *
 * Output discipline: markdown only — no JSON, no secrets (entities go
 * through assertNoSecrets() inside renderEntityPage), no raw DB rows.
 * If total output would exceed --max-bytes (default 64 KiB) the script
 * truncates with a "(refresh truncated)" marker so a runaway dataset
 * never blows the agent's prompt budget.
 *
 * Exit codes: 0 on success (even with missing slugs — they become
 * markers), non-zero only on hard failures (workspace lookup, IO).
 */
import fs from "node:fs";
import path from "node:path";

import { db } from "../src/db/connection.ts";
import {
  renderEntityPage,
  type RenderResult,
} from "../src/services/entities.ts";
import { QoopiaError } from "../src/utils/errors.ts";

// ---------------------------------------------------------------------------
// Slug list reader
// ---------------------------------------------------------------------------

const DEFAULT_SLUGS_FILE = "/etc/qoopia/mainmemory_refresh_slugs.txt";
const DEFAULT_MAX_BYTES = 64 * 1024;

export function readSlugs(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const slugs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    slugs.push(line);
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Workspace resolver (shared with migrate script)
// ---------------------------------------------------------------------------

function resolveWorkspaceId(slug: string): string {
  const row = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ? LIMIT 1`)
    .get(slug) as { id: string } | undefined;
  if (!row) {
    throw new Error(
      `workspace slug '${slug}' not found; create it before running refresh`,
    );
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// Render orchestration
// ---------------------------------------------------------------------------

export interface RefreshOptions {
  slugs: string[];
  workspaceId: string;
  maxBytes: number;
}

export interface RefreshOutput {
  markdown: string;
  slugCount: number;
  missingSlugs: string[];
  truncated: boolean;
  bytes: number;
}

export function refresh(opts: RefreshOptions): RefreshOutput {
  const segments: string[] = [];
  const missing: string[] = [];

  segments.push(
    `<!-- mainmemory_refresh: ${opts.slugs.length} slug(s), workspace_id=${opts.workspaceId} -->`,
  );
  segments.push("");

  for (const slug of opts.slugs) {
    let r: RenderResult | null = null;
    try {
      r = renderEntityPage({ workspace_id: opts.workspaceId, slug });
    } catch (err) {
      const code =
        err instanceof QoopiaError ? (err as QoopiaError).code : "ERROR";
      missing.push(slug);
      segments.push(`<!-- mainmemory_refresh: missing slug='${slug}' code=${code} -->`);
      segments.push("");
      continue;
    }
    segments.push(r.markdown);
    segments.push("");
  }

  let markdown = segments.join("\n").replace(/\n+$/, "") + "\n";
  let truncated = false;
  const byteLen = Buffer.byteLength(markdown, "utf8");
  if (byteLen > opts.maxBytes) {
    // Trim by character; record actual byte count post-trim.
    const safe = Buffer.from(markdown, "utf8")
      .subarray(0, opts.maxBytes)
      .toString("utf8");
    markdown =
      safe.replace(/\n[^\n]*$/, "") +
      `\n\n<!-- mainmemory_refresh: truncated at ${opts.maxBytes} bytes -->\n`;
    truncated = true;
  }
  return {
    markdown,
    slugCount: opts.slugs.length,
    missingSlugs: missing,
    truncated,
    bytes: Buffer.byteLength(markdown, "utf8"),
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface CliArgs {
  slugsFile: string;
  workspaceSlug: string;
  maxBytes: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (const raw of argv) {
    if (raw.startsWith("--slugs-file=")) {
      args.slugsFile = raw.slice("--slugs-file=".length);
    } else if (raw.startsWith("--workspace-slug=")) {
      args.workspaceSlug = raw.slice("--workspace-slug=".length);
    } else if (raw.startsWith("--max-bytes=")) {
      args.maxBytes = parseInt(raw.slice("--max-bytes=".length), 10);
    }
  }
  if (!args.workspaceSlug) {
    throw new Error("--workspace-slug=<slug> is required");
  }
  return {
    slugsFile: args.slugsFile ?? DEFAULT_SLUGS_FILE,
    workspaceSlug: args.workspaceSlug,
    maxBytes:
      args.maxBytes && Number.isFinite(args.maxBytes) && args.maxBytes > 0
        ? args.maxBytes
        : DEFAULT_MAX_BYTES,
  };
}

export function runCli(argv: string[]): RefreshOutput {
  const args = parseArgs(argv);
  const slugs = readSlugs(args.slugsFile);
  const workspaceId = resolveWorkspaceId(args.workspaceSlug);
  return refresh({
    slugs,
    workspaceId,
    maxBytes: args.maxBytes,
  });
}

if (import.meta.main) {
  const out = runCli(process.argv.slice(2));
  process.stdout.write(out.markdown);
  if (out.missingSlugs.length > 0) {
    process.stderr.write(
      `mainmemory_refresh: ${out.missingSlugs.length} missing slug(s): ${out.missingSlugs.join(", ")}\n`,
    );
  }
}
