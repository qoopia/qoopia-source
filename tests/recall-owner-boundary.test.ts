// F-078 / ADR-020: no principal of workspace A reads another workspace through
// recall{cross_workspace} or session_search{scope:'all'}, on any channel — neither
// B of an independent owner nor C, which records the same explicit owner.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { legacyPrivilegedAgent } from "./helpers/legacy-agent.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { createNote } from "../src/services/notes.ts";
import { EMBED_DIM, EMBED_MODEL, serializeEmbedding, textHash } from "../src/services/embeddings.ts";
import { findTool } from "../src/mcp/tools.ts";
import { currentToolAuth } from "../src/auth/policy.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

const suffix = randomUUID();
let a = "", privA = "", ownerA = "", stdA = "", stewardA = "", c = "", cOriginalOwner = "";
let stub: ReturnType<typeof Bun.serve> | null = null;
const savedEnv = { ...process.env };

function axisVector() {
  const v = new Float32Array(EMBED_DIM);
  v[0] = 1;
  return serializeEmbedding(v);
}

function seedNoteVector(id: string, workspace: string, text: string) {
  db.query(`INSERT INTO notes_embeddings (note_id, workspace_id, embedding, dim, model, text_hash) VALUES (?,?,?,?,?,?)`)
    .run(id, workspace, axisVector(), EMBED_DIM, EMBED_MODEL, textHash(text));
}

function seedEntity(workspace: string, title: string) {
  const id = `xw-entity-${randomUUID()}`;
  db.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title) VALUES (?,?,'knowledge',?,?)").run(id, workspace, id, title);
  db.query(`INSERT INTO entity_embeddings (entity_id, workspace_id, embedding, dim, model, text_hash) VALUES (?,?,?,?,?,?)`)
    .run(id, workspace, axisVector(), EMBED_DIM, EMBED_MODEL, textHash(title));
}

beforeAll(() => {
  runMigrations();
  const wa = createWorkspace({ name: `xw tenant A ${suffix}`, slug: `xw-tenant-a-${suffix}` });
  const wb = createWorkspace({ name: `xw tenant B ${suffix}`, slug: `xw-tenant-b-${suffix}` });
  const wc = createWorkspace({ name: `xw tenant C ${suffix}`, slug: `xw-tenant-c-${suffix}` });
  a = wa.id;
  c = wc.id;
  privA = legacyPrivilegedAgent(`xw-priv-${suffix}`, wa.slug).id;
  stdA = createAgent({ name: `xw-std-${suffix}`, workspaceSlug: wa.slug }).id;
  stewardA = createAgent({ name: `xw-steward-${suffix}`, workspaceSlug: wa.slug, type: "steward" }).id;
  ownerA = bootstrapOwner(db, `xw owner A ${suffix}`, undefined, wa.id).agent_id;
  bootstrapOwner(db, `xw owner B ${suffix}`, undefined, wb.id); // independent owner of B
  cOriginalOwner = bootstrapOwner(db, `xw owner C ${suffix}`, undefined, wc.id).agent_id;
  // Legacy same-installation owner identity: C records A's owner explicitly.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id=?").run(ownerA, wc.id);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  const gammaB = createAgent({ name: `xw-gamma-${suffix}`, workspaceSlug: wb.slug }).id;
  createNote({ workspace_id: wb.id, agent_id: gammaB, text: "tenantb private secret quokka", visibility: "private" });
  createNote({ workspace_id: wb.id, agent_id: gammaB, text: "tenantb task quokka", type: "task" });
  saveMessage({ workspace_id: wb.id, agent_id: gammaB, session_id: `xw-b-${suffix}`, role: "user", content: "tenantb transcript quokka" });
  db.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title) VALUES (?,?,'knowledge',?,'tenantb entity quokka')")
    .run(`xw-b-entity-${suffix}`, wb.id, `xw-b-entity-${suffix}`);
  const bVector = "tenantb vector-only memory about lighthouses";
  seedNoteVector(createNote({ workspace_id: wb.id, agent_id: gammaB, text: bVector, type: "memory" }).id, wb.id, bVector);
  seedEntity(wb.id, "tenantb vector entity lighthouses");

  const deltaC = createAgent({ name: `xw-delta-${suffix}`, workspaceSlug: wc.slug }).id;
  createNote({ workspace_id: wc.id, agent_id: deltaC, text: "tenantc shared quokka" });
  saveMessage({ workspace_id: wc.id, agent_id: deltaC, session_id: `xw-c-${suffix}`, role: "user", content: "tenantc transcript quokka" });
  const cVector = "tenantc vector-only memory about lighthouses";
  seedNoteVector(createNote({ workspace_id: wc.id, agent_id: deltaC, text: cVector, type: "memory" }).id, wc.id, cVector);

  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { input?: string };
      const vec = Array.from({ length: EMBED_DIM }, () => 0);
      vec[String(body.input).includes("wantvec-xw") ? 0 : 9] = 1;
      return Response.json({ model: EMBED_MODEL, embeddings: [vec] });
    },
  });
  process.env.QOOPIA_EMBED_ENDPOINT = `http://127.0.0.1:${stub.port}/api/embed`;
  process.env.QOOPIA_EMBED_TIMEOUT_MS = "1000";
  process.env.QOOPIA_ENTITY_PAGES = "true";
});

afterAll(() => {
  stub?.stop(true);
  db.query("UPDATE workspace_owners SET actor_id=? WHERE workspace_id=?").run(cOriginalOwner, c);
  for (const key of ["QOOPIA_EMBED_ENDPOINT", "QOOPIA_EMBED_TIMEOUT_MS", "QOOPIA_ENTITY_PAGES", "QOOPIA_RECALL_MODE"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const run = (agent: string, type: string, tool: string, args: Record<string, unknown>) =>
  findTool(tool)!.handler(args, currentToolAuth(db, { agent_id: agent, agent_name: "xw", workspace_id: a, type, source: "api-key", tool_profile: "full" } as AuthContext, "read"));
const texts = (r: any): string[] => (r.results ?? []).map((x: any) => x.text ?? x.content);

// ADR-020 (supersedes F-078's same-owner reach): no principal of A — not the owner, not the
// steward, not claude-privileged — reads workspace B of an independent owner or workspace C that
// records the same owner, through recall{cross_workspace} or session_search{scope:'all'}, on any channel.
test("setup: A has its own transcript", () => {
  saveMessage({ workspace_id: a, agent_id: stdA, session_id: `xw-a-${suffix}`, role: "user", content: "home transcript quokka" });
});

for (const who of ["claude-privileged", "owner", "steward", "standard"] as const) {
  const id = () => (who === "owner" ? ownerA : who === "claude-privileged" ? privA : who === "steward" ? stewardA : stdA);

  test(`${who} of A: recall cross_workspace stays in A on every channel`, async () => {
    const r = await run(id(), who, "recall", { query: "quokka", cross_workspace: true, scope: "all", limit: 50 });
    expect(JSON.stringify(r)).not.toContain("tenantb");
    expect(JSON.stringify(r)).not.toContain("tenantc");
    expect(texts(r)).toContain("home transcript quokka");
  });

  test(`${who} of A: hybrid vector channels never load B's or C's embeddings`, async () => {
    process.env.QOOPIA_RECALL_MODE = "hybrid";
    try {
      const r = await run(id(), who, "recall", { query: "wantvec-xw", cross_workspace: true, scope: "notes", limit: 50 });
      expect(JSON.stringify(r)).not.toContain("tenantb");
      expect(JSON.stringify(r)).not.toContain("tenantc");
    } finally {
      delete process.env.QOOPIA_RECALL_MODE;
    }
  });

  test(`${who} of A: session_search scope 'all' is A only`, async () => {
    const r = await run(id(), who, "session_search", { query: "quokka", scope: "all" });
    expect(texts(r)).toEqual(["home transcript quokka"]);
  });
}
