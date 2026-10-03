/**
 * F-013: the V2 compat aliases stay behind QOOPIA_ENABLE_V2_COMPAT=true as a
 * rollback switch. Every alias is called here through registerTools with the
 * flag on, so the rollback path is not untested code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { registerTools } from "../src/mcp/tools.ts";
import { createNote, getNote } from "../src/services/notes.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

type Handler = (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;

const oldFlag = process.env.QOOPIA_ENABLE_V2_COMPAT;
let alice: AuthContext;
let bob: AuthContext;

function aliases(auth: AuthContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const capture = (name: string, ...rest: unknown[]) => {
    handlers.set(name, rest[rest.length - 1] as Handler);
  };
  registerTools(
    { tool: capture, registerTool: capture } as unknown as Parameters<typeof registerTools>[0],
    () => auth,
    "full",
    { agentToolProfile: "full" },
  );
  return handlers;
}

/** Calls an alias and returns its JSON result, or `{ error }` with the error text. */
async function call(auth: AuthContext, name: string, args: Record<string, unknown>) {
  const handler = aliases(auth).get(name);
  if (!handler) throw new Error(`alias ${name} not registered`);
  const result = await handler(args);
  const text = result.content[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}

beforeAll(() => {
  process.env.QOOPIA_ENABLE_V2_COMPAT = "true";
  runMigrations();
  const ws = createWorkspace({ name: "Compat Aliases", slug: "compat-aliases" });
  const mk = (name: string): AuthContext => ({
    agent_id: createAgent({ name, workspaceSlug: ws.slug }).id,
    agent_name: name,
    workspace_id: ws.id,
    type: "standard",
    source: "api-key",
    tool_profile: "full",
  });
  alice = mk("compat-alice");
  bob = mk("compat-bob");
});

afterAll(() => {
  if (oldFlag === undefined) delete process.env.QOOPIA_ENABLE_V2_COMPAT;
  else process.env.QOOPIA_ENABLE_V2_COMPAT = oldFlag;
});

describe("V2 compat aliases through registerTools", () => {
  test("create, get, list, update, note and delete round-trip", async () => {
    const created = await call(alice, "create", {
      entity: "tasks",
      title: "Compat task",
      description: "details",
      status: "todo",
    });
    expect(created.type).toBe("task");

    const got = await call(alice, "get", { entity: "tasks", id: created.id });
    expect(got.text).toBe("Compat task\n\ndetails");

    const listed = await call(alice, "list", { entity: "tasks" });
    expect(JSON.stringify(listed)).toContain(created.id);

    await call(alice, "update", { entity: "tasks", id: created.id, title: "Renamed", status: "done" });
    const updated = getNote(alice.workspace_id, created.id, alice.agent_id, false);
    expect(updated.text).toBe("Renamed\n\ndetails");
    expect(updated.metadata.status).toBe("done");

    const memo = await call(alice, "note", { text: "compat memory", type: "memory" });
    expect(getNote(alice.workspace_id, memo.id, alice.agent_id, false).metadata.v2_compat).toBe(true);

    expect((await call(alice, "delete", { entity: "tasks", id: created.id })).error).toBeUndefined();
    expect((await call(alice, "get", { entity: "tasks", id: created.id })).error).toMatch(/^NOT_FOUND/);
  });

  test("entity type mismatch is rejected and leaves the note alone", async () => {
    const deal = await call(alice, "create", { entity: "deals", name: "Compat deal" });
    expect((await call(alice, "update", { entity: "tasks", id: deal.id, title: "x" })).error)
      .toMatch(/^INVALID_INPUT: Entity type mismatch/);
    expect((await call(alice, "delete", { entity: "tasks", id: deal.id })).error)
      .toMatch(/^INVALID_INPUT: Entity type mismatch/);
    expect((await call(alice, "get", { entity: "tasks", id: deal.id })).error).toMatch(/^NOT_FOUND/);
    expect(getNote(alice.workspace_id, deal.id, alice.agent_id, false).text).toBe("Compat deal");
  });

  test("another agent's private note is invisible to every alias", async () => {
    const secret = createNote({
      workspace_id: bob.workspace_id,
      agent_id: bob.agent_id,
      text: "bob private task",
      type: "task",
      visibility: "private",
    });
    for (const [name, args] of [
      ["get", { entity: "tasks", id: secret.id }],
      ["update", { entity: "tasks", id: secret.id, title: "hijacked" }],
      ["delete", { entity: "tasks", id: secret.id }],
    ] as const) {
      expect((await call(alice, name, args)).error).toMatch(/^NOT_FOUND/);
    }
    expect(JSON.stringify(await call(alice, "list", { entity: "tasks" }))).not.toContain(secret.id);
    expect(getNote(bob.workspace_id, secret.id, bob.agent_id, false).text).toBe("bob private task");
  });
});
