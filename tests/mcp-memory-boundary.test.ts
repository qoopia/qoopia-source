/**
 * QRERUN-003 / ADR-014 regression: prove the MCP memory boundary.
 *
 * Within one workspace:
 *  - 'workspace' notes (default) are visible to any agent — that is the
 *    product (shared workspace memory layer).
 *  - 'private' notes are visible only to the owning agent_id and to
 *    admin types (steward, claude-privileged) for ops/audit.
 *
 * The test exercises the service-level functions directly (createNote,
 * getNote, listNotes, recall, brief) with explicit caller_agent_id /
 * is_admin so the boundary is verified independently of MCP transport.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import {
  createNote,
  getNote,
  listNotes,
} from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import { brief } from "../src/services/brief.ts";
import { QoopiaError } from "../src/utils/errors.ts";

let WORKSPACE_ID = "";
let AGENT_A = "";
let AGENT_B = "";
let ADMIN_AGENT = "";

let A_WORKSPACE_NOTE = "";
let A_PRIVATE_NOTE = "";
let B_WORKSPACE_NOTE = "";
let B_PRIVATE_NOTE = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Boundary Test", slug: "boundary-test" });
  WORKSPACE_ID = ws.id;

  AGENT_A = createAgent({ name: "agent-a", workspaceSlug: ws.slug }).id;
  AGENT_B = createAgent({ name: "agent-b", workspaceSlug: ws.slug }).id;
  // Steward type — bypasses the private filter via is_admin=true.
  ADMIN_AGENT = createAgent({
    name: "boundary-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  }).id;

  // Two notes per agent: one workspace-visibility (default), one private.
  // Use the keyword "boundarymarker" so recall() can match all of them.
  A_WORKSPACE_NOTE = createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_A,
    text: "boundarymarker shared from a",
  }).id;
  A_PRIVATE_NOTE = createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_A,
    text: "boundarymarker private a-only",
    visibility: "private",
  }).id;
  B_WORKSPACE_NOTE = createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_B,
    text: "boundarymarker shared from b",
  }).id;
  B_PRIVATE_NOTE = createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_B,
    text: "boundarymarker private b-only",
    visibility: "private",
  }).id;
});

describe("ADR-014 invariant 1: standard agent reads sibling's workspace note", () => {
  test("getNote — agent A can read agent B's workspace note", async () => {
    const fetched = getNote(WORKSPACE_ID, B_WORKSPACE_NOTE, AGENT_A, false);
    expect(fetched.id).toBe(B_WORKSPACE_NOTE);
    expect(fetched.visibility).toBe("workspace");
  });
});

describe("ADR-014 invariant 2: standard agent CANNOT read sibling's private note", () => {
  test("getNote — agent A reading agent B's private note throws NOT_FOUND", async () => {
    expect(() =>
      getNote(WORKSPACE_ID, B_PRIVATE_NOTE, AGENT_A, false),
    ).toThrow(QoopiaError);
  });

  test("listNotes — agent A does not see agent B's private note", async () => {
    const result = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
    });
    const ids = result.items.map((n) => n.id);
    expect(ids).toContain(A_WORKSPACE_NOTE);
    expect(ids).toContain(A_PRIVATE_NOTE); // own private is visible
    expect(ids).toContain(B_WORKSPACE_NOTE); // workspace-visibility shared
    expect(ids).not.toContain(B_PRIVATE_NOTE); // sibling's private hidden
  });

  test("recall — agent A does not surface agent B's private note in FTS", async () => {
    const result = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      query: "boundarymarker",
      limit: 50,
    });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(A_WORKSPACE_NOTE);
    expect(ids).toContain(A_PRIVATE_NOTE);
    expect(ids).toContain(B_WORKSPACE_NOTE);
    expect(ids).not.toContain(B_PRIVATE_NOTE);
  });

  test("brief — agent A does not surface agent B's private note in recent_notes", async () => {
    const result = brief({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
    });
    const ids = result.recent_notes.items.map((n) => n.id);
    expect(ids).not.toContain(B_PRIVATE_NOTE);
  });
});

describe("ADR-014 invariant 3: admin agent (steward) sees sibling private notes", () => {
  test("getNote — admin reads agent B's private note", async () => {
    const fetched = getNote(WORKSPACE_ID, B_PRIVATE_NOTE, ADMIN_AGENT, true);
    expect(fetched.id).toBe(B_PRIVATE_NOTE);
    expect(fetched.visibility).toBe("private");
  });

  test("listNotes — admin sees ALL notes including private from other agents", async () => {
    const result = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: ADMIN_AGENT,
      is_admin: true,
    });
    const ids = result.items.map((n) => n.id);
    expect(ids).toContain(A_PRIVATE_NOTE);
    expect(ids).toContain(B_PRIVATE_NOTE);
  });

  test("recall — admin surfaces all private notes via FTS", async () => {
    const result = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: ADMIN_AGENT,
      is_admin: true,
      query: "boundarymarker",
      limit: 50,
    });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(A_PRIVATE_NOTE);
    expect(ids).toContain(B_PRIVATE_NOTE);
  });
});

describe("ADR-014 invariant 4: standard agent reads its own private note", () => {
  test("getNote — agent A reads its own private note", async () => {
    const fetched = getNote(WORKSPACE_ID, A_PRIVATE_NOTE, AGENT_A, false);
    expect(fetched.id).toBe(A_PRIVATE_NOTE);
    expect(fetched.visibility).toBe("private");
  });

  test("recall — agent A surfaces own private note", async () => {
    const result = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      query: "boundarymarker",
      limit: 50,
    });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(A_PRIVATE_NOTE);
  });
});

describe("QSA-B / Codex QSA-001: brief() agent_activity sibling-leak", () => {
  test("non-admin sees only their own row in agent_activity", async () => {
    const r = brief({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
    });
    const names = Object.keys(r.agent_activity as Record<string, unknown>);
    expect(names).toContain("agent-a");
    expect(names).not.toContain("agent-b");
    expect(names).not.toContain("boundary-steward");
  });

  test("non-admin filtering by another agent's name does NOT bypass the restriction", async () => {
    // p.agent is silently ignored for non-admins; the result must still be
    // self-only, not the requested sibling.
    const r = brief({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      agent: "agent-b",
    });
    const names = Object.keys(r.agent_activity as Record<string, unknown>);
    expect(names).not.toContain("agent-b");
    expect(names).toEqual(["agent-a"]);
  });

  test("admin still sees workspace-wide activity for all agents", async () => {
    const r = brief({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: ADMIN_AGENT,
      is_admin: true,
    });
    const names = Object.keys(r.agent_activity as Record<string, unknown>);
    expect(names).toContain("agent-a");
    expect(names).toContain("agent-b");
    expect(names).toContain("boundary-steward");
  });

  test("admin can still narrow agent_activity via p.agent filter", async () => {
    const r = brief({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: ADMIN_AGENT,
      is_admin: true,
      agent: "agent-b",
    });
    const names = Object.keys(r.agent_activity as Record<string, unknown>);
    expect(names).toEqual(["agent-b"]);
  });
});

describe("ADR-014 default behavior: omitted visibility = 'workspace'", () => {
  test("createNote without visibility defaults to 'workspace'", async () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A,
      text: "default visibility check",
    });
    expect(r.visibility).toBe("workspace");
    const fetched = getNote(WORKSPACE_ID, r.id, AGENT_B, false);
    expect(fetched.visibility).toBe("workspace");
  });
});
