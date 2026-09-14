/**
 * Entity pages MVP — service-layer and integration tests (Phase 2 Item C,
 * migrations 021-022). All tests run against a per-process temp DB
 * provisioned by tests/setup.ts; the production DB is never touched.
 *
 * Coverage map (preflight self-review checklist + R2 BLOCK additions):
 *  - upsert idempotency on (workspace, slug)
 *  - slug uniqueness scoped per workspace (same slug, different workspaces → both succeed)
 *  - self-loop forbidden at the DB CHECK level
 *  - duplicate link triple is a silent no-op
 *  - entity_page_render markdown shape + outgoing/incoming sections
 *  - entity_search filters by type and via FTS5 query
 *  - migration round-trip on a scratch DB: 021/022 apply + rollback clean
 *  - recall integration: entity row surfaces with source='entity'
 *  - R2: acceptance (d) — documents link to agentcomm-e2e-skill stub renders correctly
 *  - R2: recall top-k global ranking when notes and entities compete
 *  - R2: feature flag default off (subprocess check on src/mcp/tools.ts)
 *
 * Feature flag: this file opts into QOOPIA_ENTITY_PAGES at module load
 * so the recall entity channel and (when registerTools is called) the
 * MCP entity surface are both exercised. The default-OFF behaviour is
 * verified by a subprocess test below.
 */
process.env.QOOPIA_ENTITY_PAGES = "true";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import {
  upsertEntity,
  getEntity,
  searchEntities,
  addLink,
  renderEntityPage,
  ENTITY_TYPES,
} from "../src/services/entities.ts";
import { recall } from "../src/services/recall.ts";
import { createNote } from "../src/services/notes.ts";
import { QoopiaError } from "../src/utils/errors.ts";
import { principalAuth } from "./helpers/p1-fixtures.ts";

let WORKSPACE_A = "";
let WORKSPACE_B = "";
let AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const wsA = createWorkspace({ name: "Entity Test A", slug: "ent-test-a" });
  WORKSPACE_A = wsA.id;
  const wsB = createWorkspace({ name: "Entity Test B", slug: "ent-test-b" });
  WORKSPACE_B = wsB.id;
  const ag = createAgent({ name: "ent-tester", workspaceSlug: wsA.slug });
  AGENT_ID = ag.id;
});

afterAll(() => {
  // setup.ts unlinks the tmp dir on exit; nothing to do here.
});

describe("upsertEntity", () => {
  test("creates a new entity and assigns a ULID id", () => {
    const r = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "protocol",
      slug: "agentcomm-protocol",
      title: "AgentComm protocol",
      summary: "L0–L6 event-push protocol with loop-prevention.",
      metadata: { participants: ["corsair-main", "leo"] },
    });
    expect(r.created).toBe(true);
    expect(r.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(r.workspace_id).toBe(WORKSPACE_A);

    const got = getEntity({ workspace_id: WORKSPACE_A, id: r.id });
    expect(got.title).toBe("AgentComm protocol");
    expect(got.type).toBe("protocol");
    expect(got.status).toBe("active");
    expect(got.metadata.participants).toEqual(["corsair-main", "leo"]);
  });

  test("is idempotent on (workspace, slug) — second call updates same id", () => {
    const first = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "agent",
      slug: "corsair-main-agent",
      title: "corsair-main (initial)",
    });
    const second = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "agent",
      slug: "corsair-main-agent",
      title: "corsair-main (updated)",
      summary: "Now with summary.",
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const got = getEntity({ workspace_id: WORKSPACE_A, slug: "corsair-main-agent" });
    expect(got.title).toBe("corsair-main (updated)");
    expect(got.summary).toBe("Now with summary.");
  });

  test("slug uniqueness is scoped per workspace (same slug, different workspace = both succeed)", () => {
    upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "knowledge",
      slug: "shared-slug",
      title: "WS A entry",
    });
    const inB = upsertEntity({
      workspace_id: WORKSPACE_B,
      type: "knowledge",
      slug: "shared-slug",
      title: "WS B entry",
    });
    expect(inB.created).toBe(true);

    const a = getEntity({ workspace_id: WORKSPACE_A, slug: "shared-slug" });
    const b = getEntity({ workspace_id: WORKSPACE_B, slug: "shared-slug" });
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe("WS A entry");
    expect(b.title).toBe("WS B entry");
  });

  test("rejects unknown type", () => {
    expect(() =>
      upsertEntity({
        workspace_id: WORKSPACE_A,
        // @ts-expect-error — intentional bad input
        type: "alien",
        slug: "alien-slug",
        title: "x",
      }),
    ).toThrow(QoopiaError);
  });

  test("rejects unsafe slug", () => {
    expect(() =>
      upsertEntity({
        workspace_id: WORKSPACE_A,
        type: "knowledge",
        slug: "Slug With Spaces",
        title: "x",
      }),
    ).toThrow(/url-safe/);
  });

  test("rejects empty title", () => {
    expect(() =>
      upsertEntity({
        workspace_id: WORKSPACE_A,
        type: "knowledge",
        slug: "valid-slug-empty-title",
        title: "",
      }),
    ).toThrow(QoopiaError);
  });

  test("rejects secret-bearing summary", () => {
    expect(() =>
      upsertEntity({
        workspace_id: WORKSPACE_A,
        type: "knowledge",
        slug: "leak-summary",
        title: "Leak guard test",
        summary: "leaked q_EXAMPLE_PLACEHOLDER_KEY",
      }),
    ).toThrow(QoopiaError);
  });
});

describe("getEntity", () => {
  test("returns NOT_FOUND for cross-workspace lookup by slug", () => {
    upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "knowledge",
      slug: "iso-a-only",
      title: "WS A only",
    });
    expect(() =>
      getEntity({ workspace_id: WORKSPACE_B, slug: "iso-a-only" }),
    ).toThrow(/not found/);
  });

  test("rejects when both id and slug omitted", () => {
    expect(() => getEntity({ workspace_id: WORKSPACE_A })).toThrow(
      /id or slug is required/,
    );
  });
});

describe("addLink", () => {
  let aId = "";
  let bId = "";
  let cId = "";

  beforeAll(() => {
    aId = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "protocol",
      slug: "link-a",
      title: "Link source",
    }).id;
    bId = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "agent",
      slug: "link-b",
      title: "Link target",
    }).id;
    cId = upsertEntity({
      workspace_id: WORKSPACE_B,
      type: "agent",
      slug: "link-c-other-ws",
      title: "Other WS entity",
    }).id;
  });

  test("creates a link between two entities in the same workspace", () => {
    const r = addLink({
      workspace_id: WORKSPACE_A,
      source_entity_id: aId,
      target_entity_id: bId,
      relation_type: "participants",
    });
    expect(r.inserted).toBe(true);
    expect(typeof r.link_id).toBe("number");
  });

  test("is idempotent on the (source, target, relation_type) triple", () => {
    const r = addLink({
      workspace_id: WORKSPACE_A,
      source_entity_id: aId,
      target_entity_id: bId,
      relation_type: "participants",
    });
    expect(r.inserted).toBe(false);
    expect(r.link_id).not.toBeNull();
  });

  test("forbids self-loops at the service layer", () => {
    expect(() =>
      addLink({
        workspace_id: WORKSPACE_A,
        source_entity_id: aId,
        target_entity_id: aId,
        relation_type: "related_to",
      }),
    ).toThrow(/self-loop forbidden/);
  });

  test("forbids self-loops at the DB CHECK level too (defense in depth)", () => {
    // Bypass the service layer — write straight to the DB to confirm
    // the CHECK constraint refuses the row even when the service
    // wouldn't have stopped it.
    expect(() => {
      db.prepare(
        `INSERT INTO entity_links (source_entity_id, target_entity_id, relation_type)
         VALUES (?, ?, ?)`,
      ).run(aId, aId, "raw-self-loop");
    }).toThrow(/CHECK constraint/);
  });

  test("rejects link whose target lives in a different workspace", () => {
    expect(() =>
      addLink({
        workspace_id: WORKSPACE_A,
        source_entity_id: aId,
        target_entity_id: cId,
        relation_type: "documents",
      }),
    ).toThrow(/not found/);
  });

  test("rejects link with unknown endpoint", () => {
    expect(() =>
      addLink({
        workspace_id: WORKSPACE_A,
        source_entity_id: aId,
        target_entity_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        relation_type: "documents",
      }),
    ).toThrow(/not found/);
  });
});

describe("renderEntityPage", () => {
  test("renders markdown with title, summary, metadata, and link sections", () => {
    const src = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "protocol",
      slug: "render-src",
      title: "Render source",
      summary: "Summary body for render test.",
      metadata: { tier: "production" },
    });
    const tgt = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "agent",
      slug: "render-tgt",
      title: "Render target",
    });
    addLink({
      workspace_id: WORKSPACE_A,
      source_entity_id: src.id,
      target_entity_id: tgt.id,
      relation_type: "documents",
    });

    const r = renderEntityPage({ workspace_id: WORKSPACE_A, slug: "render-src" });
    expect(r.markdown).toContain("# Render source");
    expect(r.markdown).toContain("Summary body for render test.");
    expect(r.markdown).toContain("## Metadata");
    expect(r.markdown).toContain("tier");
    expect(r.markdown).toContain("## Outgoing links");
    expect(r.markdown).toMatch(/\*\*documents\*\* → `render-tgt`/);
    expect(r.truncated).toBe(false);

    // Reverse direction: render the target → incoming link.
    const t = renderEntityPage({ workspace_id: WORKSPACE_A, slug: "render-tgt" });
    expect(t.markdown).toContain("## Incoming links");
    expect(t.markdown).toContain("render-src");
  });
});

describe("searchEntities", () => {
  beforeAll(() => {
    upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "agent",
      slug: "search-agent-1",
      title: "Hermes reviewer agent",
      summary: "Reviews AgentComm protocols.",
    });
    upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "service",
      slug: "search-svc-1",
      title: "Qoopia recall service",
    });
  });

  test("filters by type when no query is provided", () => {
    const hits = searchEntities({
      workspace_id: WORKSPACE_A,
      type: "service",
    });
    // Only the service entry should appear; protocol/agent entries excluded.
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toContain("search-svc-1");
    expect(slugs).not.toContain("search-agent-1");
  });

  test("FTS5 query returns matching entity by title", () => {
    const hits = searchEntities({
      workspace_id: WORKSPACE_A,
      query: "Hermes",
    });
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toContain("search-agent-1");
  });

  test("workspace boundary — does not return entries from other workspaces", () => {
    upsertEntity({
      workspace_id: WORKSPACE_B,
      type: "agent",
      slug: "search-cross-ws",
      title: "Hermes from WS B",
    });
    const hits = searchEntities({
      workspace_id: WORKSPACE_A,
      query: "Hermes",
    });
    const slugs = hits.map((h) => h.slug);
    expect(slugs).not.toContain("search-cross-ws");
  });
});

// PHASE3_HYGIENE_FTS5_SANITIZE_BUG (task 01KSDSHWAP991GNCC8EDFN39MF):
// ftsSanitize previously emitted bare tokens, so any FTS5-metachar query
// (hyphens confirmed in prod; colons/quotes/parens likely) raised
// SQLiteError "no such column: ...". These tests pin the quoted-literal fix.
describe("searchEntities — FTS5 metacharacter sanitization", () => {
  beforeAll(() => {
    upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "service",
      slug: "fts5-hyphen-probe",
      title: "phase3 item-a deploy probe",
      summary: "Regression fixture for hyphenated FTS5 queries.",
    });
  });

  test("hyphenated query does not throw and still surfaces the entity", () => {
    let hits: ReturnType<typeof searchEntities> = [];
    expect(() => {
      hits = searchEntities({
        workspace_id: WORKSPACE_A,
        query: "phase3-item-a-deploy",
      });
    }).not.toThrow();
    expect(hits.map((h) => h.slug)).toContain("fts5-hyphen-probe");
  });

  test("colon query is handled safely (no SQLiteError)", () => {
    expect(() =>
      searchEntities({ workspace_id: WORKSPACE_A, query: "rev:abc123" }),
    ).not.toThrow();
  });

  test("double-quote query is handled safely (no SQLiteError)", () => {
    expect(() =>
      searchEntities({ workspace_id: WORKSPACE_A, query: '"phase3 item-a"' }),
    ).not.toThrow();
  });

  test("parenthesis / boolean-operator query is handled safely (no SQLiteError)", () => {
    expect(() =>
      searchEntities({ workspace_id: WORKSPACE_A, query: "(foo OR bar)" }),
    ).not.toThrow();
  });

  test("query with only sub-2-char tokens returns [] without error", () => {
    let hits: ReturnType<typeof searchEntities> = [];
    expect(() => {
      hits = searchEntities({ workspace_id: WORKSPACE_A, query: "- a" });
    }).not.toThrow();
    expect(hits).toEqual([]);
  });
});

describe("recall integration", () => {
  test("entity page surfaces in recall results with source='entity'", async () => {
    upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "protocol",
      slug: "recall-it-protocol",
      title: "RecallIntegrationProtocol unique-token",
      summary: "Probe for recall integration.",
    });
    const r = await recall({
      workspace_id: WORKSPACE_A,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "RecallIntegrationProtocol",
      limit: 5,
    });
    const entityHits = r.results.filter((row: any) => row.source === "entity");
    expect(entityHits.length).toBeGreaterThan(0);
    expect(entityHits[0].slug).toBe("recall-it-protocol");
    expect(entityHits[0].type).toBe("entity:protocol");
  });

  test("scope='entities' returns only entity rows", async () => {
    const r = await recall({
      workspace_id: WORKSPACE_A,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "RecallIntegrationProtocol",
      scope: "entities",
      limit: 5,
    });
    for (const row of r.results as any[]) {
      expect(row.source).toBe("entity");
    }
  });
});

describe("ENTITY_TYPES vocabulary covers Phase 2 Item C requirements", () => {
  test("includes the documented set", () => {
    expect(new Set(ENTITY_TYPES)).toEqual(
      new Set([
        "person",
        "agent",
        "machine",
        "service",
        "project",
        "protocol",
        "incident",
        "skill",
        "knowledge",
      ]),
    );
  });
});

describe("migration round-trip on scratch DB", () => {
  /**
   * Spin up a brand-new sqlite file, replay the on-disk migrations
   * 001-022 inside it, then apply the rollbacks 022 + 021, and assert
   * the resulting schema has no `entity_pages*` / `entity_links*` /
   * `entity_embeddings*` objects left. This is the cleanliness gate
   * for the rollback files — they are run from prod restore tooling,
   * so they must leave the DB in a state identical to "before the
   * Item C migrations were applied".
   */
  test("021+022 forward then rollback leaves no entity_* objects", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ent-rb-"));
    const dbPath = path.join(tmp, "scratch.db");
    const sdb = new Database(dbPath, { create: true });
    sdb.exec("PRAGMA foreign_keys = ON");
    const root = path.resolve(import.meta.dir, "..");
    const migDir = path.join(root, "migrations");
    const files = fs
      .readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      sdb.exec(fs.readFileSync(path.join(migDir, f), "utf8"));
    }
    // Pre-rollback: entity tables exist.
    const preObjs = sdb
      .prepare(
        `SELECT name FROM sqlite_master WHERE name LIKE 'entity_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(preObjs.length).toBeGreaterThanOrEqual(3);

    // Apply rollbacks in reverse order.
    sdb.exec(
      fs.readFileSync(
        path.join(migDir, "rollback", "022-entity-links.rollback.sql"),
        "utf8",
      ),
    );
    sdb.exec(
      fs.readFileSync(
        path.join(migDir, "rollback", "021-entity-pages.rollback.sql"),
        "utf8",
      ),
    );

    const postObjs = sdb
      .prepare(
        `SELECT name FROM sqlite_master WHERE name LIKE 'entity_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(postObjs).toEqual([]);

    // schema_versions rows for 21+22 removed.
    const versions = sdb
      .prepare(
        `SELECT version FROM schema_versions WHERE version IN (21, 22)`,
      )
      .all() as Array<{ version: number }>;
    expect(versions).toEqual([]);

    sdb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("R2 acceptance (d) — documents link to agentcomm-e2e-skill stub", () => {
  /**
   * Phase 2 plan §"Item C — Acceptance test" (d) requires that
   *   entity_link('agentcomm-protocol', 'agentcomm-e2e-skill', 'documents')
   * succeeds and the renderer shows the link. Leo R1 BLOCK §1
   * rejected the R1 deferral; R2 satisfies (d) inline by seeding a
   * stub skill entity (metadata.item_e_stub=true) so the link target
   * exists today. Item E will replace the stub when the fat skills
   * layer ships.
   */
  let protocolId = "";
  let stubId = "";

  beforeAll(() => {
    const protocol = upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "protocol",
      slug: "r2-acc-d-protocol",
      title: "Item-C-R2 acceptance (d) protocol",
      summary: "Acceptance (d) source entity.",
    });
    protocolId = protocol.id;

    const stub = upsertEntity({
      expected_revision: 0, idempotency_key: "entity-skill-stub",
      workspace_id: WORKSPACE_A,
      type: "skill",
      slug: "r2-acc-d-e2e-skill",
      title: "Item-C-R2 acceptance (d) skill (Item E stub)",
      summary:
        "Stub entity seeded by Item C R2; replaced by Item E.",
      metadata: {},
    }, principalAuth(db, AGENT_ID));
    stubId = stub.id;

    addLink({
      workspace_id: WORKSPACE_A,
      source_entity_id: protocolId,
      target_entity_id: stubId,
      relation_type: "documents",
      source: "item-c-r2-stub",
    });
  });

  test("renderer shows the documents link", () => {
    const r = renderEntityPage({ workspace_id: WORKSPACE_A, id: protocolId });
    expect(r.markdown).toContain("## Outgoing links");
    expect(r.markdown).toMatch(/\*\*documents\*\* → `r2-acc-d-e2e-skill`/);
    expect(r.markdown).toContain("Item-C-R2 acceptance (d) skill");
  });

  test("incoming-link side shows the protocol", () => {
    const r = renderEntityPage({ workspace_id: WORKSPACE_A, id: stubId });
    expect(r.markdown).toContain("## Incoming links");
    expect(r.markdown).toContain("r2-acc-d-protocol");
  });

  test("entity_link rejects a duplicate triple (idempotency on (source, target, documents))", () => {
    const r2 = addLink({
      workspace_id: WORKSPACE_A,
      source_entity_id: protocolId,
      target_entity_id: stubId,
      relation_type: "documents",
    });
    expect(r2.inserted).toBe(false);
    expect(r2.link_id).not.toBeNull();
  });
});

describe("mixed-source recall baseline when notes and entities compete", () => {
  /**
   * Notes and entity pages are queried from separate FTS corpora, then WS-6
   * maps each source's ordinal order onto one RRF scale. Equal ordinals use
   * the documented entity-before-note tie-break.
   */
  const competeWorkspace: string[] = [];

  beforeAll(() => {
    // Spin up a dedicated workspace so we have full control over the
    // corpus the ranker sees (other describe blocks have polluted
    // WORKSPACE_A with unrelated entities + notes).
    const ws = createWorkspace({
      name: "Compete Test",
      slug: "compete-test",
    });
    const ag = createAgent({
      name: "compete-tester",
      workspaceSlug: ws.slug,
    });
    competeWorkspace.push(ws.id, ag.id);

    // Canonical entity — its title contains both query terms verbatim.
    upsertEntity({
      workspace_id: ws.id,
      type: "protocol",
      slug: "compete-agentcomm-protocol",
      title: "AgentComm protocol canonical entity",
      summary:
        "Canonical entry for the AgentComm protocol — link target for " +
        "all agents implementing the AgentComm protocol contract.",
    });

    // 5 competing notes containing both query terms in the body.
    for (let i = 0; i < 5; i++) {
      createNote({
        workspace_id: ws.id,
        agent_id: ag.id,
        text: `Note ${i}: discussion of the AgentComm protocol, including timing and protocol handshake notes related to AgentComm.`,
        type: "note",
      });
    }
  });

  test("exact canonical entity wins the cross-source ordinal tie", async () => {
    const [ws] = competeWorkspace;
    const r = await recall({
      workspace_id: ws,
      caller_agent_id: competeWorkspace[1]!,
      is_admin: false,
      query: "AgentComm protocol",
      limit: 10,
    });
    expect(r.results[0]?.source).toBe("entity");
    expect((r.results[0] as any)?.slug).toBe("compete-agentcomm-protocol");
    expect(r.results.length).toBeLessThanOrEqual(10);
  });

  test("notes still surface in the mixed result — entities don't displace everything", async () => {
    const [ws] = competeWorkspace;
    const r = await recall({
      workspace_id: ws,
      caller_agent_id: competeWorkspace[1]!,
      is_admin: false,
      query: "AgentComm protocol",
      limit: 10,
    });
    const sources = new Set(r.results.map((row: any) => row.source));
    expect(sources.has("notes")).toBe(true);
    expect(sources.has("entity")).toBe(true);
  });
});

describe("R2 feature flag — QOOPIA_ENTITY_PAGES default off", () => {
  /**
   * The MCP entity surface is registered at module load if
   * `process.env.QOOPIA_ENTITY_PAGES === "true"`. Inside this test
   * file the env was set at top-of-file, so the in-process import
   * already has it on. To verify the default-OFF case we spawn a
   * Bun subprocess with the env explicitly UNSET and observe the
   * `toolNames("full")` output.
   *
   * Leo R1 BLOCK §3 required the feature flag — this test gates
   * regressions where someone re-introduces unconditional
   * registration.
   */
  test("subprocess without QOOPIA_ENTITY_PAGES: entity_* tools absent from MCP surface", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const snippet = `
      delete process.env.QOOPIA_ENTITY_PAGES;
      const m = await import("${root}/src/mcp/tools.ts");
      const names = m.toolNames("full");
      const entity = names.filter((n) => n.startsWith("entity_"));
      console.log(JSON.stringify({ names_len: names.length, entity }));
    `;
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", snippet],
      env: { ...process.env, QOOPIA_ENTITY_PAGES: "" },
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = child.stdout.toString();
    const err = child.stderr.toString();
    if (child.exitCode !== 0) {
      throw new Error(
        `subprocess exit=${child.exitCode}\nstderr:\n${err}\nstdout:\n${out}`,
      );
    }
    const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
    expect(parsed.entity).toEqual([]);
    expect(parsed.names_len).toBeGreaterThan(0);
  });

  test("subprocess with QOOPIA_ENTITY_PAGES=true: entity_* tools present in MCP surface", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const snippet = `
      const m = await import("${root}/src/mcp/tools.ts");
      const names = m.toolNames("full");
      const entity = names.filter((n) => n.startsWith("entity_")).sort();
      console.log(JSON.stringify({ entity }));
    `;
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", snippet],
      env: { ...process.env, QOOPIA_ENTITY_PAGES: "true" },
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = child.stdout.toString();
    const err = child.stderr.toString();
    if (child.exitCode !== 0) {
      throw new Error(
        `subprocess exit=${child.exitCode}\nstderr:\n${err}\nstdout:\n${out}`,
      );
    }
    const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
    expect(parsed.entity.sort()).toEqual([
      "entity_get",
      "entity_link",
      "entity_page_render",
      "entity_search",
      "entity_upsert",
    ]);
  });

  test("recall entity channel short-circuits when flag is off (in-process check via env mutation)", async () => {
    // Mutate the env, run a recall, restore. recall() reads the env
    // at call time so this round-trip is safe.
    const prev = process.env.QOOPIA_ENTITY_PAGES;
    upsertEntity({
      workspace_id: WORKSPACE_A,
      type: "knowledge",
      slug: "flag-off-probe",
      title: "Flag off probe entity",
      summary: "Probe — should NOT surface in recall when flag is off.",
    });
    try {
      process.env.QOOPIA_ENTITY_PAGES = "false";
      const r = await recall({
        workspace_id: WORKSPACE_A,
        caller_agent_id: AGENT_ID,
        is_admin: false,
        query: "Flag off probe",
        limit: 10,
      });
      const entityHits = r.results.filter(
        (row: any) => row.source === "entity",
      );
      expect(entityHits.length).toBe(0);
    } finally {
      process.env.QOOPIA_ENTITY_PAGES = prev;
    }
  });
});
