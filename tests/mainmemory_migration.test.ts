/**
 * Phase 2 Item F — MAINMEMORY migration + refresh hook tests.
 *
 * All tests run against the per-process temp DB provisioned by
 * tests/setup.ts. Synthetic MAINMEMORY samples are written into a
 * fresh tmp dir per `describe` block; the real per-agent MAINMEMORY at
 * /home/askhat/.ductor-corsairmain/workspace/memory_system/MAINMEMORY.md
 * is NEVER read or written by this file. Test brief hard-codes this
 * rule.
 *
 * Coverage:
 *  - parser splits H2 sections + pre-H2 intro
 *  - parser skips SHARED KNOWLEDGE delimited block
 *  - classifier identifies durable / ephemeral / stale by header keyword
 *  - planner counts buckets and assigns slugs/types for durable sections
 *  - migration --apply upserts entities + writes stub MAINMEMORY
 *  - re-running migration on a stub is a no-op (idempotency)
 *  - refresh reads slugs file, renders entities, handles missing slugs
 *  - refresh truncates oversize output
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { getEntity, upsertEntity } from "../src/services/entities.ts";

import {
  applyMigration,
  classifySection,
  deriveSlug,
  durableEntityType,
  parseMainmemory,
  planMigration,
  run as runMigrate,
} from "../scripts/mainmemory_migrate.ts";
import {
  readSlugs,
  refresh as runRefresh,
} from "../scripts/mainmemory_refresh.ts";

let WORKSPACE_ID = "";
let WORKSPACE_SLUG = "";
let TMP_ROOT = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "Item F Test Workspace",
    slug: "itemf-test",
  });
  WORKSPACE_ID = ws.id;
  WORKSPACE_SLUG = ws.slug;
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "itemf-"));
});

afterAll(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Synthetic MAINMEMORY samples
// ---------------------------------------------------------------------------

const SAMPLE_FULL = `# Corsair Main

You are the Corsair main agent. Identity persona here.

## Bootstrap facts
- Created on Corsair on synthetic-date.
- Dedicated SSH key path: /home/test/.ssh/id_synth.

## Corsair baseline (synthetic)
- Ubuntu 24.04, 32 CPU.
- Docker installed.

## Agent-to-agent comms protocol
- Async dispatch via webhook.
- Loop prevention via close=true.

## Phase 2 Item X — state с 2026-05-24
- Round 3 BLOCK by Leo.
- Recent test failures: 2.

## Recent incident log
- 2026-05-24 incident: nothing happened.

## Deprecated config note
- This config is no longer used.

--- SHARED KNOWLEDGE START ---
Shared knowledge is owned by edit_shared_knowledge.py.
Do not touch this block from migrate.ts.
--- SHARED KNOWLEDGE END ---
`;

function writeSample(filename: string, content: string): string {
  const p = path.join(TMP_ROOT, filename);
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseMainmemory", () => {
  test("splits into pre-H2 intro plus H2 sections", () => {
    const sections = parseMainmemory(SAMPLE_FULL);
    // 1 intro + 6 H2 sections (SHARED KNOWLEDGE block excluded)
    expect(sections.length).toBe(7);
    expect(sections[0]!.header).toBeNull();
    expect(sections[0]!.body).toContain("Identity persona");
    expect(sections[1]!.header).toBe("Bootstrap facts");
    expect(sections[2]!.header).toBe("Corsair baseline (synthetic)");
    expect(sections[3]!.header).toBe("Agent-to-agent comms protocol");
    expect(sections[4]!.header).toBe("Phase 2 Item X — state с 2026-05-24");
    expect(sections[5]!.header).toBe("Recent incident log");
    expect(sections[6]!.header).toBe("Deprecated config note");
  });

  test("SHARED KNOWLEDGE block is ignored entirely", () => {
    const sections = parseMainmemory(SAMPLE_FULL);
    for (const s of sections) {
      expect(s.body).not.toContain("Shared knowledge is owned");
      expect(s.body).not.toContain("edit_shared_knowledge");
    }
  });

  test("empty input returns no sections", () => {
    expect(parseMainmemory("")).toEqual([]);
  });

  test("intro without H2 returns single section with null header", () => {
    const sections = parseMainmemory("# Title\n\nJust persona.\n");
    expect(sections.length).toBe(1);
    expect(sections[0]!.header).toBeNull();
    expect(sections[0]!.body).toContain("Just persona");
  });
});

// ---------------------------------------------------------------------------
// Classifier + slug derivation
// ---------------------------------------------------------------------------

describe("classifySection", () => {
  test("pre-H2 intro classifies durable as 'agent'", () => {
    const intro = { header: null, body: "persona", startLine: 1, endLine: 1 };
    const cls = classifySection(intro);
    expect(cls.bucket).toBe("durable");
    expect(durableEntityType(intro)?.type).toBe("agent");
  });

  test("'Bootstrap facts' is durable knowledge", () => {
    const s = { header: "Bootstrap facts", body: "", startLine: 1, endLine: 1 };
    expect(classifySection(s).bucket).toBe("durable");
    expect(durableEntityType(s)?.type).toBe("knowledge");
  });

  test("'Corsair baseline' is durable machine", () => {
    const s = {
      header: "Corsair baseline (synthetic)",
      body: "",
      startLine: 1,
      endLine: 1,
    };
    expect(classifySection(s).bucket).toBe("durable");
    expect(durableEntityType(s)?.type).toBe("machine");
  });

  test("'Agent-to-agent comms protocol' is durable protocol", () => {
    const s = {
      header: "Agent-to-agent comms protocol",
      body: "",
      startLine: 1,
      endLine: 1,
    };
    expect(classifySection(s).bucket).toBe("durable");
    expect(durableEntityType(s)?.type).toBe("protocol");
  });

  test("'Phase X — state' is ephemeral", () => {
    const s = {
      header: "Phase 2 Item X — state с 2026-05-24",
      body: "",
      startLine: 1,
      endLine: 1,
    };
    expect(classifySection(s).bucket).toBe("ephemeral");
  });

  test("'Recent incident log' is ephemeral", () => {
    const s = {
      header: "Recent incident log",
      body: "",
      startLine: 1,
      endLine: 1,
    };
    expect(classifySection(s).bucket).toBe("ephemeral");
  });

  test("'Deprecated' marker classifies as stale", () => {
    const s = {
      header: "Deprecated config note",
      body: "",
      startLine: 1,
      endLine: 1,
    };
    expect(classifySection(s).bucket).toBe("stale");
  });

  test("unknown header falls through to ephemeral (conservative default)", () => {
    const s = {
      header: "Some Random Topic Nobody Knows",
      body: "",
      startLine: 1,
      endLine: 1,
    };
    expect(classifySection(s).bucket).toBe("ephemeral");
  });
});

describe("deriveSlug", () => {
  test("null header → 'corsair-main-persona'", () => {
    expect(deriveSlug(null)).toBe("corsair-main-persona");
  });
  test("strips date qualifier in parentheses", () => {
    expect(deriveSlug("Corsair baseline (2026-05-21)")).toBe(
      "corsair-baseline",
    );
  });
  test("strips after em-dash", () => {
    expect(deriveSlug("Phase 2 Item X — state с 2026-05-24")).toBe(
      "phase-2-item-x",
    );
  });
  test("lowercases and kebab-cases", () => {
    expect(deriveSlug("Agent-to-agent COMMS Protocol")).toBe(
      "agent-to-agent-comms-protocol",
    );
  });
  test("produces a valid entity slug shape", () => {
    const slug = deriveSlug("Bootstrap facts!!!");
    expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/);
  });
});

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

describe("planMigration", () => {
  test("counts buckets and assigns slugs/types for durable", () => {
    const plan = planMigration(parseMainmemory(SAMPLE_FULL));
    // intro + Bootstrap + baseline + comms = 4 durable
    // Phase X state + Recent incident = 2 ephemeral
    // Deprecated = 1 stale
    expect(plan.counts.durable).toBe(4);
    expect(plan.counts.ephemeral).toBe(2);
    expect(plan.counts.stale).toBe(1);

    const durable = plan.entries.filter(
      (e) => e.classification.bucket === "durable",
    );
    for (const d of durable) {
      expect(d.slug).toBeTruthy();
      expect(d.entityType).toBeTruthy();
      expect(d.title).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// applyMigration (integration)
// ---------------------------------------------------------------------------

describe("applyMigration", () => {
  test("dry-run reports correct entity_upsert simulation counts", () => {
    const src = writeSample("dryrun.md", SAMPLE_FULL);
    const result = runMigrate([
      `--source=${src}`,
      `--workspace-slug=${WORKSPACE_SLUG}`,
      // no --apply
    ]);
    expect(result.mode).toBe("dry-run");
    expect(result.counts.durable).toBe(4);
    expect(result.counts.ephemeral).toBe(2);
    expect(result.counts.stale).toBe(1);
    expect(result.durable.length).toBe(4);
    expect(result.apply).toBeUndefined();
    // source file unchanged (no write because no --apply)
    expect(fs.readFileSync(src, "utf8")).toBe(SAMPLE_FULL);
  });

  test("--apply upserts entities and writes the stub MAINMEMORY", () => {
    const src = writeSample("apply.md", SAMPLE_FULL);
    const out = src; // overwrite in place

    const result = runMigrate([
      `--source=${src}`,
      `--workspace-slug=${WORKSPACE_SLUG}`,
      `--out=${out}`,
      "--apply",
    ]);
    expect(result.mode).toBe("apply");
    expect(result.apply).toBeTruthy();
    expect(result.apply!.upsertResults.length).toBe(4);
    // first run: all 4 created
    const created = result.apply!.upsertResults.filter((r) => r.created).length;
    expect(created).toBe(4);

    // Entities now retrievable by slug
    for (const r of result.apply!.upsertResults) {
      const ent = getEntity({
        workspace_id: WORKSPACE_ID,
        slug: r.slug,
      });
      expect(ent.metadata.migrated_from).toBe("MAINMEMORY.md");
      expect(ent.metadata.source_path).toBe(path.resolve(src));
      expect(typeof ent.metadata.migrated_at).toBe("string");
    }

    // Stub MAINMEMORY written, shorter than original, SoT header on line 1
    const stub = fs.readFileSync(out, "utf8");
    expect(stub.length).toBeLessThan(SAMPLE_FULL.length);
    expect(stub.startsWith("# Cache file — refresh from Qoopia entity pages")).toBe(
      true,
    );
    // Ephemeral sections preserved verbatim
    expect(stub).toContain("## Phase 2 Item X — state с 2026-05-24");
    expect(stub).toContain("## Recent incident log");
    // Stale section dropped
    expect(stub).not.toContain("Deprecated config note");
    // Durable headers no longer present
    expect(stub).not.toContain("## Bootstrap facts");
    expect(stub).not.toContain("## Corsair baseline");
    expect(stub).not.toContain("## Agent-to-agent comms protocol");
  });

  test("re-running --apply on already-stubbed MAINMEMORY is a no-op for durables", () => {
    const src = writeSample("idempotent.md", SAMPLE_FULL);
    runMigrate([
      `--source=${src}`,
      `--workspace-slug=${WORKSPACE_SLUG}`,
      "--apply",
    ]);
    // After first run, source is the stub.
    const second = runMigrate([
      `--source=${src}`,
      `--workspace-slug=${WORKSPACE_SLUG}`,
      "--apply",
    ]);
    // Stub has zero durable sections; second run upserts nothing
    expect(second.counts.durable).toBe(0);
    expect(second.apply!.upsertResults.length).toBe(0);
  });

  test("re-running --apply on the original MAINMEMORY hits 'created=false' (idempotent on slug)", () => {
    const src = writeSample("rerun.md", SAMPLE_FULL);
    // First apply (writes stub to a different out path so we can re-read source)
    const out1 = path.join(TMP_ROOT, "rerun.stub1.md");
    runMigrate([
      `--source=${src}`,
      `--workspace-slug=${WORKSPACE_SLUG}`,
      `--out=${out1}`,
      "--apply",
    ]);
    // Second apply against same source (still the original SAMPLE_FULL)
    const out2 = path.join(TMP_ROOT, "rerun.stub2.md");
    const second = runMigrate([
      `--source=${src}`,
      `--workspace-slug=${WORKSPACE_SLUG}`,
      `--out=${out2}`,
      "--apply",
    ]);
    const updated = second.apply!.upsertResults.filter((r) => !r.created).length;
    expect(updated).toBe(4);
    expect(second.apply!.upsertResults.every((r) => !r.skipped)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe("mainmemory_refresh", () => {
  test("readSlugs ignores empty lines and # comments", () => {
    const file = path.join(TMP_ROOT, "slugs.txt");
    fs.writeFileSync(
      file,
      "# header comment\n\nfoo-slug\nbar-slug\n# trailing comment\nbaz-slug\n",
    );
    expect(readSlugs(file)).toEqual(["foo-slug", "bar-slug", "baz-slug"]);
  });

  test("readSlugs returns [] when file does not exist", () => {
    expect(readSlugs(path.join(TMP_ROOT, "no-such-file.txt"))).toEqual([]);
  });

  test("refresh renders entities and emits markdown for each slug", () => {
    // Seed two entities in this workspace
    upsertEntity({
      workspace_id: WORKSPACE_ID,
      type: "knowledge",
      slug: "refresh-target-a",
      title: "Refresh A",
      summary: "Body of A.",
    });
    upsertEntity({
      workspace_id: WORKSPACE_ID,
      type: "knowledge",
      slug: "refresh-target-b",
      title: "Refresh B",
      summary: "Body of B.",
    });
    const out = runRefresh({
      slugs: ["refresh-target-a", "refresh-target-b"],
      workspaceId: WORKSPACE_ID,
      maxBytes: 64 * 1024,
    });
    expect(out.slugCount).toBe(2);
    expect(out.missingSlugs).toEqual([]);
    expect(out.markdown).toContain("# Refresh A");
    expect(out.markdown).toContain("# Refresh B");
    expect(out.markdown).toContain("Body of A");
    expect(out.markdown).toContain("Body of B");
    expect(out.truncated).toBe(false);
  });

  test("refresh records missing slugs as markers, not failures", () => {
    const out = runRefresh({
      slugs: ["refresh-target-a", "definitely-does-not-exist"],
      workspaceId: WORKSPACE_ID,
      maxBytes: 64 * 1024,
    });
    expect(out.missingSlugs).toEqual(["definitely-does-not-exist"]);
    expect(out.markdown).toContain("missing slug='definitely-does-not-exist'");
    expect(out.markdown).toContain("# Refresh A");
  });

  test("refresh truncates output above max-bytes", () => {
    upsertEntity({
      workspace_id: WORKSPACE_ID,
      type: "knowledge",
      slug: "big-entity",
      title: "Big",
      summary: "x".repeat(2000),
    });
    const out = runRefresh({
      slugs: ["big-entity"],
      workspaceId: WORKSPACE_ID,
      maxBytes: 512,
    });
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeLessThanOrEqual(700); // header + truncation marker overhead
    expect(out.markdown).toContain("truncated at 512 bytes");
  });
});
