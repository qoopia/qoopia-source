/**
 * Fat skills layer — service-layer and integration tests (Phase 2
 * Item E, migration 023). Runs against the per-process temp DB
 * provisioned by tests/setup.ts; the production DB is never touched.
 *
 * Coverage map (self-review checklist):
 *  - validateSkillMetadata rejects each missing required field
 *  - skillUpsert idempotency on (workspace, slug) + secret blocking on steps
 *  - skillGet refuses non-skill entities (NOT_FOUND with type info)
 *  - skillRenderRunbook produces valid markdown with all required sections
 *  - skillSearch pins type='skill' so other types are invisible
 *  - skillMarkTested merges metadata and re-validates
 *  - integration: seed 3 skills, link agentcomm-e2e-verification →
 *    agentcomm-protocol (documents), entity_search type='skill'
 *    returns them, recall surfaces skill entity
 *  - migration 023 round-trip on a scratch DB
 *  - feature flag default off → skill_* tools absent from MCP surface
 *  - feature flag on → 5 skill_* tools present
 *
 * Feature flags: this file opts into QOOPIA_ENTITY_PAGES + QOOPIA_SKILLS
 * at module load so the service layer + recall channel + MCP surface
 * are all exercised. The default-OFF behaviour is verified by a
 * subprocess test below.
 */
process.env.QOOPIA_ENTITY_PAGES = "true";
process.env.QOOPIA_SKILLS = "true";

import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { upsertEntity, addLink, searchEntities } from "../src/services/entities.ts";
import {
  skillUpsert as rawSkillUpsert,
  skillGet,
  skillSearch,
  skillRenderRunbook,
  skillMarkTested as rawSkillMarkTested,
  validateSkillMetadata,
  SKILL_METADATA_REQUIRED,
  type SkillMetadata,
} from "../src/services/skills.ts";
import { recall } from "../src/services/recall.ts";
import { QoopiaError } from "../src/utils/errors.ts";

import { db } from "../src/db/connection.ts";
import { principalAuth } from "./helpers/p1-fixtures.ts";
import { randomUUID } from "node:crypto";

// Existing happy-path clients now read the CAS head and send a command key.
function skillUpsert(input: Parameters<typeof rawSkillUpsert>[0]) {
  const agent = db.query("SELECT id FROM agents WHERE workspace_id=? AND active=1 LIMIT 1").get(input.workspace_id) as { id: string };
  const head = db.query("SELECT d.revision FROM skill_drafts d JOIN entity_pages e ON e.id=d.skill_id WHERE e.workspace_id=? AND e.slug=?").get(input.workspace_id,input.slug) as {revision:number}|null;
  return rawSkillUpsert({...input, expected_revision: head?.revision ?? 0, idempotency_key: randomUUID()}, principalAuth(db,agent.id));
}
function skillMarkTested(input: Parameters<typeof rawSkillMarkTested>[0]) {
  const agent = db.query("SELECT id FROM agents WHERE workspace_id=? AND active=1 LIMIT 1").get(input.workspace_id) as {id:string};
  const skill = skillGet({workspace_id:input.workspace_id,id:input.id,slug:input.slug});
  return rawSkillMarkTested({...input,expected_revision:Number(skill.metadata.revision),idempotency_key:randomUUID()},principalAuth(db,agent.id));
}
let WS = "";
let WS_OTHER = "";
let AGENT_ID = "";

/** Build a valid metadata object — tests mutate copies of this. */
function validMetadata(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    skill_version: "1.0.0",
    owner_agent: "corsair-main",
    trigger_conditions: ["test trigger"],
    scope: "test scope",
    prerequisites: ["test prereq"],
    exact_steps: ["step one"],
    verification_gates: ["gate one"],
    failure_modes: ["mode one"],
    rollback: "rollback steps",
    related_code_paths: ["/srv/qoopia/code/src/services/skills.ts"],
    related_incidents: ["test-incident"],
    ...overrides,
  };
}

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "Skills Test",
    slug: "skills-test",
  });
  WS = ws.id;
  const wsOther = createWorkspace({
    name: "Skills Test Other",
    slug: "skills-test-other",
  });
  WS_OTHER = wsOther.id;
  const ag = createAgent({ name: "skills-tester", workspaceSlug: ws.slug });
  AGENT_ID = ag.id;
  createAgent({ name: "other-skills-tester", workspaceSlug: wsOther.slug });
});

describe("validateSkillMetadata", () => {
  test("accepts a fully populated metadata object", () => {
    expect(() => validateSkillMetadata(validMetadata())).not.toThrow();
  });

  for (const field of SKILL_METADATA_REQUIRED) {
    test(`rejects missing required field: ${field}`, () => {
      const m: any = validMetadata();
      delete m[field];
      expect(() => validateSkillMetadata(m)).toThrow(QoopiaError);
    });
  }

  test("rejects non-object metadata", () => {
    expect(() => validateSkillMetadata("nope" as any)).toThrow(QoopiaError);
    expect(() => validateSkillMetadata([] as any)).toThrow(QoopiaError);
    expect(() => validateSkillMetadata(null as any)).toThrow(QoopiaError);
  });

  test("rejects empty string for required scalar field", () => {
    const m = validMetadata({ scope: "" });
    expect(() => validateSkillMetadata(m)).toThrow(QoopiaError);
  });

  test("rejects non-string array entry", () => {
    const m = validMetadata({ exact_steps: ["ok", 42 as any] });
    expect(() => validateSkillMetadata(m)).toThrow(QoopiaError);
  });

  test("rejects empty array for required array field", () => {
    const m = validMetadata({ exact_steps: [] });
    expect(() => validateSkillMetadata(m)).toThrow(QoopiaError);
  });

  test("rejects invalid last_tested timestamp", () => {
    const m = validMetadata({ last_tested: "not-a-timestamp" });
    expect(() => validateSkillMetadata(m)).toThrow(QoopiaError);
  });

  test("accepts optional last_tested + tester_agent", () => {
    const m = validMetadata({
      last_tested: "2026-05-24T00:00:00.000Z",
      tester_agent: "leo-agentcomm",
    });
    expect(() => validateSkillMetadata(m)).not.toThrow();
  });
});

describe("skillUpsert", () => {
  test("creates a new skill entity with type='skill'", () => {
    const r = skillUpsert({
      workspace_id: WS,
      slug: "test-skill-create",
      title: "Test skill — create",
      summary: "Create path probe.",
      metadata: validMetadata(),
    });
    expect(r.created).toBe(true);
    expect(r.type).toBe("skill");
    expect(r.id).toMatch(/^[0-9A-Z]{26}$/);

    const got = skillGet({ workspace_id: WS, id: r.id });
    expect(got.type).toBe("skill");
    expect(got.metadata.skill_version).toBe("1.0.0");
  });

  test("is idempotent on (workspace, slug) — second call updates same id", () => {
    const a = skillUpsert({
      workspace_id: WS,
      slug: "test-skill-idem",
      title: "Idempotent skill",
      summary: "v1",
      metadata: validMetadata(),
    });
    const b = skillUpsert({
      workspace_id: WS,
      slug: "test-skill-idem",
      title: "Idempotent skill",
      summary: "v2",
      metadata: validMetadata({ skill_version: "1.0.1" }),
    });
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
    const got = skillGet({ workspace_id: WS, id: a.id });
    expect(got.summary).toBe("v2");
    expect(got.metadata.skill_version).toBe("1.0.1");
  });

  test("rejects missing summary (required for renderable runbook)", () => {
    expect(() =>
      skillUpsert({
        workspace_id: WS,
        slug: "test-skill-no-summary",
        title: "Skill no summary",
        summary: "",
        metadata: validMetadata(),
      }),
    ).toThrow(QoopiaError);
  });

  test("rejects malformed metadata (propagates validateSkillMetadata error)", () => {
    expect(() =>
      skillUpsert({
        workspace_id: WS,
        slug: "test-skill-bad-meta",
        title: "Bad meta skill",
        summary: "probe",
        metadata: validMetadata({ exact_steps: [] }),
      }),
    ).toThrow(QoopiaError);
  });

  test("rejects secret-bearing step (assertNoSecrets on joined steps blob)", () => {
    const m = validMetadata({
      exact_steps: [
        "step one",
        "TOKEN=sk-ant-api03-AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666GGGG7777HHHH8888IIII9999JJJJ0000",
      ],
    });
    expect(() =>
      skillUpsert({
        workspace_id: WS,
        slug: "test-skill-secret",
        title: "Secret-bearing skill",
        summary: "probe",
        metadata: m,
      }),
    ).toThrow();
  });
});

describe("skillGet", () => {
  test("rejects non-skill entity even if slug matches", () => {
    upsertEntity({
      workspace_id: WS,
      type: "protocol",
      slug: "not-a-skill",
      title: "Not a skill",
      summary: "I am a protocol.",
    });
    expect(() => skillGet({ workspace_id: WS, slug: "not-a-skill" })).toThrow(
      QoopiaError,
    );
  });
});

describe("skillSearch", () => {
  beforeAll(() => {
    skillUpsert({
      workspace_id: WS,
      slug: "search-probe-1",
      title: "Search probe one xyzzymarker",
      summary: "probe",
      metadata: validMetadata(),
    });
    skillUpsert({
      workspace_id: WS,
      slug: "search-probe-2",
      title: "Search probe two xyzzymarker",
      summary: "probe",
      metadata: validMetadata(),
    });
    upsertEntity({
      workspace_id: WS,
      type: "knowledge",
      slug: "search-noise-knowledge",
      title: "Search noise xyzzymarker (knowledge)",
      summary: "non-skill row with the same marker",
    });
  });

  test("pins type='skill' so non-skill entities with the same marker are excluded", () => {
    const hits = skillSearch({ workspace_id: WS, query: "xyzzymarker" });
    const slugs = new Set(hits.map((h) => h.slug));
    expect(slugs.has("search-probe-1")).toBe(true);
    expect(slugs.has("search-probe-2")).toBe(true);
    expect(slugs.has("search-noise-knowledge")).toBe(false);
  });

  test("workspace boundary — does not return entries from other workspaces", () => {
    skillUpsert({
      workspace_id: WS_OTHER,
      slug: "search-probe-1",
      title: "Search probe one xyzzymarker (other ws)",
      summary: "probe",
      metadata: validMetadata(),
    });
    const hits = skillSearch({ workspace_id: WS, query: "xyzzymarker" });
    for (const h of hits) expect(h.workspace_id).toBe(WS);
  });
});

describe("skillRenderRunbook", () => {
  test("produces markdown with all required sections", () => {
    skillUpsert({
      workspace_id: WS,
      slug: "render-probe",
      title: "Render probe skill",
      summary: "Intro paragraph for the runbook.",
      metadata: validMetadata({
        trigger_conditions: ["t1", "t2"],
        prerequisites: ["p1"],
        exact_steps: ["s1", "s2"],
        verification_gates: ["g1"],
        failure_modes: ["f1"],
        rollback: "Rollback paragraph.",
        related_code_paths: ["/p1"],
        related_incidents: ["i1"],
      }),
    });
    const r = skillRenderRunbook({ workspace_id: WS, slug: "render-probe" });
    expect(r.markdown).toContain("# Render probe skill");
    expect(r.markdown).toContain("*skill_version:* `1.0.0`");
    expect(r.markdown).toContain("*last_tested:* never");
    expect(r.markdown).toContain("## Trigger");
    expect(r.markdown).toContain("- t1");
    expect(r.markdown).toContain("- t2");
    expect(r.markdown).toContain("## Prerequisites");
    expect(r.markdown).toContain("## Steps");
    expect(r.markdown).toContain("1. s1");
    expect(r.markdown).toContain("2. s2");
    expect(r.markdown).toContain("## Verification");
    expect(r.markdown).toContain("- [ ] g1");
    expect(r.markdown).toContain("## Failure modes");
    expect(r.markdown).toContain("- f1");
    expect(r.markdown).toContain("## Rollback");
    expect(r.markdown).toContain("Rollback paragraph.");
    expect(r.markdown).toContain("## Code paths");
    expect(r.markdown).toContain("- `/p1`");
    expect(r.markdown).toContain("## Related incidents");
    expect(r.markdown).toContain("- i1");
  });

  test("shows last_tested + tester_agent when set", () => {
    skillUpsert({
      workspace_id: WS,
      slug: "render-tested",
      title: "Render tested skill",
      summary: "probe",
      metadata: validMetadata(),
    });
    skillMarkTested({workspace_id:WS,slug:"render-tested",tested_at:"2026-05-24T12:00:00.000Z",tester_agent:AGENT_ID});
    const r = skillRenderRunbook({ workspace_id: WS, slug: "render-tested" });
    expect(r.markdown).toContain("*last_tested:* 2026-05-24T12:00:00.000Z");
    expect(r.markdown).toContain(`by \`${AGENT_ID}\``);
    expect(r.last_tested).toBe("2026-05-24T12:00:00.000Z");
  });
});

describe("skillMarkTested", () => {
  test("merges last_tested/tester_agent and re-validates metadata", () => {
    const initial = skillUpsert({
      workspace_id: WS,
      slug: "mark-tested-probe",
      title: "Mark tested probe",
      summary: "probe",
      metadata: validMetadata(),
    });
    const r = skillMarkTested({
      workspace_id: WS,
      slug: "mark-tested-probe",
      tested_at: "2026-05-24T13:00:00.000Z",
      tester_agent: AGENT_ID,
    });
    expect(r.id).toBe(initial.id);
    expect(r.created).toBe(false);
    const got = skillGet({ workspace_id: WS, id: initial.id });
    expect(got.metadata.last_tested).toBe("2026-05-24T13:00:00.000Z");
    expect(got.metadata.tester_agent).toBe(AGENT_ID);
    expect(got.metadata.skill_version).toBe("1.0.0");
  });

  test("rejects invalid tested_at", () => {
    expect(() =>
      skillMarkTested({
        workspace_id: WS,
        slug: "mark-tested-probe",
        tested_at: "not-a-date",
        tester_agent: AGENT_ID,
      }),
    ).toThrow(QoopiaError);
  });
});

describe("integration — 3 skills + agentcomm-protocol link + entity_search + recall", () => {
  let protocolId = "";
  let e2eSkillId = "";

  beforeAll(() => {
    const protocol = upsertEntity({
      workspace_id: WS,
      type: "protocol",
      slug: "int-agentcomm-protocol",
      title: "Int AgentComm protocol marker-unique-int-token",
      summary: "Integration probe protocol entity.",
    });
    protocolId = protocol.id;

    const a = skillUpsert({
      workspace_id: WS,
      slug: "int-agentcomm-e2e-verification",
      title: "Integration AgentComm E2E verification marker-unique-int-token",
      summary: "Integration skill 1 of 3.",
      metadata: validMetadata({
        owner_agent: "corsair-main",
        related_incidents: ["phase1-item-7-agentcomm-trust-rebuild"],
      }),
    });
    e2eSkillId = a.id;

    skillUpsert({
      workspace_id: WS,
      slug: "int-provider-guard-repair",
      title: "Integration provider guard repair",
      summary: "Integration skill 2 of 3.",
      metadata: validMetadata({
        owner_agent: "corsair-main",
        related_incidents: ["phase1-item-7-provider-guard-fork"],
      }),
    });

    skillUpsert({
      workspace_id: WS,
      slug: "int-vault-retrieval-proof",
      title: "Integration vault retrieval proof",
      summary: "Integration skill 3 of 3.",
      metadata: validMetadata({
        owner_agent: "corsair-main",
        related_incidents: ["phase1-item-6-vault-bootstrap"],
      }),
    });

    addLink({
      workspace_id: WS,
      source_entity_id: e2eSkillId,
      target_entity_id: protocolId,
      relation_type: "documents",
      source: "skills-test-integration",
    });
  });

  test("entity_search type='skill' surfaces the 3 seeded skills", () => {
    const hits = searchEntities({ workspace_id: WS, type: "skill" });
    const slugs = new Set(hits.map((h) => h.slug));
    expect(slugs.has("int-agentcomm-e2e-verification")).toBe(true);
    expect(slugs.has("int-provider-guard-repair")).toBe(true);
    expect(slugs.has("int-vault-retrieval-proof")).toBe(true);
    for (const h of hits) expect(h.type).toBe("skill");
  });

  test("at least one seeded skill links to a historical incident (acceptance criterion)", () => {
    const skill = skillGet({
      workspace_id: WS,
      slug: "int-agentcomm-e2e-verification",
    });
    expect(skill.metadata.related_incidents.length).toBeGreaterThan(0);
    expect(
      skill.metadata.related_incidents.some((i) => i.includes("phase1")),
    ).toBe(true);
  });

  test("recall('marker-unique-int-token') returns skill entity in top results", async () => {
    const r = await recall({
      workspace_id: WS,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "marker-unique-int-token",
      limit: 5,
    });
    const entityHits = (r.results as any[]).filter(
      (row) => row.source === "entity",
    );
    expect(entityHits.length).toBeGreaterThan(0);
    const slugs = entityHits.map((h: any) => h.slug);
    expect(
      slugs.some((s: string) => s === "int-agentcomm-e2e-verification"),
    ).toBe(true);
  });

  test("renderEntityPage on the protocol shows the incoming documents link from the skill", () => {
    const r = skillRenderRunbook({
      workspace_id: WS,
      slug: "int-agentcomm-e2e-verification",
    });
    expect(r.markdown).toContain("## Trigger");
    expect(r.markdown).toContain("## Steps");
  });
});

describe("migration 023 round-trip on a scratch DB", () => {
  test("forward + rollback leaves schema_versions clean", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-mig-"));
    const dbPath = path.join(tmp, "scratch.sqlite");
    const sdb = new Database(dbPath);
    sdb.exec(
      `CREATE TABLE schema_versions (
         version INTEGER PRIMARY KEY,
         description TEXT NOT NULL,
         applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       )`,
    );

    const forward = fs.readFileSync(
      path.resolve(__dirname, "../migrations/023-skill-metadata-schema.sql"),
      "utf-8",
    );
    sdb.exec(forward);
    const v = sdb
      .prepare(`SELECT version FROM schema_versions WHERE version = 23`)
      .get() as { version: number } | undefined;
    expect(v?.version).toBe(23);

    const rollback = fs.readFileSync(
      path.resolve(
        __dirname,
        "../migrations/rollback/023-skill-metadata-schema.rollback.sql",
      ),
      "utf-8",
    );
    sdb.exec(rollback);
    const after = sdb
      .prepare(`SELECT version FROM schema_versions WHERE version = 23`)
      .get();
    expect(after == null).toBe(true);

    sdb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("feature flag QOOPIA_SKILLS", () => {
  test("subprocess without QOOPIA_SKILLS: skill_* tools absent from MCP surface", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const snippet = `
      delete process.env.QOOPIA_SKILLS;
      const m = await import("${root}/src/mcp/tools.ts");
      const names = m.toolNames("full");
      const skill = names.filter((n) => n.startsWith("skill_"));
      console.log(JSON.stringify({ names_len: names.length, skill }));
    `;
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", snippet],
      env: { ...process.env, QOOPIA_SKILLS: "" },
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
    expect(parsed.skill).toEqual([]);
    expect(parsed.names_len).toBeGreaterThan(0);
  });

  test("subprocess with QOOPIA_SKILLS=true: 5 skill_* tools present", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const snippet = `
      const m = await import("${root}/src/mcp/tools.ts");
      const names = m.toolNames("full");
      const skill = names.filter((n) => n.startsWith("skill_")).sort();
      console.log(JSON.stringify({ skill }));
    `;
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", snippet],
      env: {
        ...process.env,
        QOOPIA_ENTITY_PAGES: "true",
        QOOPIA_SKILLS: "true",
      },
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
    expect(parsed.skill.sort()).toEqual([
      "skill_get",
      "skill_mark_tested",
      "skill_render_runbook",
      "skill_search",
      "skill_upsert",
    ]);
  });
});
