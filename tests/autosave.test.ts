/**
 * 5.0.18: Autosave out of the box on every runtime. A client without lifecycle hooks (ChatGPT, Claude web,
 * Grok bots, Muse) saves a conversation only when its model calls session_save, so while the owner's
 * Autosave switch is on Qoopia asks it to, at connect time and in tool results; off stops both at once.
 */
import { beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { registerTools } from "../src/mcp/tools.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { continuityEvent } from "../src/services/continuity.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { AUTOSAVE_INSTRUCTION, agentMemoryStatus, autosaveReminder, noteAgentWork, setMemoryPolicy } from "../src/services/memory-policy.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import type { OAuthScope } from "../src/auth/oauth.ts";
import { agentContractFor } from "../src/api/agent-contract.ts";
import { authorityOperations } from "../src/api/authority.ts";

type Handler = (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
let workspace: string, owner: string;
const auth = (agent_id: string): AuthContext => ({ agent_id, agent_name: agent_id, workspace_id: workspace, type: "standard", source: "api-key", tool_profile: "full" });
const agent = (name: string) => auth(createAgent({ name, workspaceSlug: "autosave-518" }).id);
async function call(who: AuthContext, name: string, args: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const capture = (tool: string, ...rest: unknown[]) => { handlers.set(tool, rest[rest.length - 1] as Handler); };
  registerTools({ tool: capture, registerTool: capture } as unknown as Parameters<typeof registerTools>[0], () => who, "full",
    { agentToolProfile: "full", grantedScope: who.granted_scope as OAuthScope[] | undefined });
  const result = await handlers.get(name)!(args);
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text);
}
const instructions = (who: AuthContext, initialize = true) => (createMcpServer(() => who, "full",
  { initialize, grantedScope: who.granted_scope as OAuthScope[] | undefined }).server as unknown as { _instructions?: string })._instructions ?? "";
const later = (who: AuthContext) => db.query("UPDATE sessions SET last_active='2026-01-01T00:00:00Z' WHERE agent_id=?").run(who.agent_id);

beforeAll(() => {
  runMigrations();
  workspace = createWorkspace({ name: "Autosave", slug: "autosave-518" }).id;
  owner = bootstrapOwner(db, "Autosave owner", undefined, workspace).agent_id;
});

test("a client without hooks is asked to save every turn until it does, and the switch stops it at once", async () => {
  const gpt = agent("autosave-gpt");
  expect(instructions(gpt)).toContain(AUTOSAVE_INSTRUCTION);
  // Only initialize reads the instructions; other requests skip the per-agent lookup.
  expect(instructions(gpt, false)).not.toContain(AUTOSAVE_INSTRUCTION);
  expect((await call(gpt, "recall", { query: "anything" })).autosave).toBe(AUTOSAVE_INSTRUCTION);
  // LIA's daily task: one message is not autosave. It silences the request briefly, like any save, then it returns.
  await call(gpt, "session_save", { session_id: "autosave-daily-task", role: "assistant", content: "Daily summary." });
  expect(agentMemoryStatus(workspace, gpt.agent_id).state).toBe("waiting");
  expect((await call(gpt, "recall", { query: "anything" })).autosave).toBeUndefined();
  later(gpt);
  expect((await call(gpt, "recall", { query: "anything" })).autosave).toBe(AUTOSAVE_INSTRUCTION);

  const saved = await call(gpt, "session_save", { user: "Где мои заметки?", assistant: "Вот они." });
  expect(saved.saved).toBe(true);
  // The day's session is not guessable from the agent id: no colleague can take it first.
  expect(saved.session_id).toMatch(/^autosave-[a-f0-9]{32}$/);
  expect(saved.session_id).not.toContain(gpt.agent_id);
  expect(saved.autosave).toBeUndefined();
  // A retried turn (equal to the last) is not stored twice; a later repeat of the same words is a new turn.
  expect((await call(gpt, "session_save", { user: "Где мои заметки?", assistant: "Вот они." })).saved).toBe(false);
  await call(gpt, "session_save", { user: "Спасибо", assistant: "Пожалуйста." });
  await call(gpt, "session_save", { user: "Где мои заметки?", assistant: "Вот они." });
  expect(db.query("SELECT COUNT(*) AS n FROM session_messages WHERE session_id=?").get(saved.session_id)).toEqual({ n: 6 });
  expect((await call(gpt, "recall", { query: "anything" })).autosave).toBeUndefined();
  // Saving; "behind" only says the summaries (no memory model here) are catching up.
  expect(["working", "behind"]).toContain(agentMemoryStatus(workspace, gpt.agent_id).state);

  // Off: no request anywhere and the save itself is refused; on again: asked and saved at once, no reconnect.
  setMemoryPolicy({ workspace_id: workspace, agent_id: gpt.agent_id, mode: "manual", actor_id: owner });
  expect(instructions(gpt)).not.toContain(AUTOSAVE_INSTRUCTION);
  expect(instructions(gpt)).toContain("note_create");
  later(gpt);
  expect((await call(gpt, "recall", { query: "anything" })).autosave).toBeUndefined();
  await expect(call(gpt, "session_save", { user: "Сохрани", assistant: "Нет" })).rejects.toThrow("APPROVAL_REQUIRED");
  setMemoryPolicy({ workspace_id: workspace, agent_id: gpt.agent_id, mode: "auto", actor_id: owner });
  expect((await call(gpt, "recall", { query: "anything" })).autosave).toBe(AUTOSAVE_INSTRUCTION);
  expect((await call(gpt, "session_save", { user: "Снова", assistant: "Сохранено." })).saved).toBe(true);
});

test("an agent that saves every message, or that cannot save, is never asked", async () => {
  // The message form after every message (the older contract) is saving; so is a tailer's capture.
  const messages = agent("autosave-messages");
  await call(messages, "session_save", { session_id: "autosave-message-form", role: "user", content: "Вопрос." });
  await call(messages, "session_save", { session_id: "autosave-message-form", role: "assistant", content: "Ответ." });
  expect((await call(messages, "recall", { query: "anything" })).autosave).toBeUndefined();
  expect(agentMemoryStatus(workspace, messages.agent_id).state).not.toBe("waiting");
  const tailed = agent("autosave-tailed");
  saveMessage({ workspace_id: workspace, agent_id: tailed.agent_id, session_id: "autosave-tailer", role: "user", content: "Синтетика.", capture: "ingest" });
  later(tailed);
  expect(instructions(tailed)).not.toContain(AUTOSAVE_INSTRUCTION);
  expect((await call(tailed, "recall", { query: "anything" })).autosave).toBeUndefined();
  // A read-only connection has no session_save: neither the instructions nor a result ask for it.
  const reader = { ...agent("autosave-reader"), granted_scope: ["mcp:read"] } as AuthContext;
  expect(instructions(reader)).not.toContain(AUTOSAVE_INSTRUCTION);
  expect((await call(reader, "recall", { query: "anything" })).autosave).toBeUndefined();
});

test("Qoopia's own capture and Claude Code/Codex clients are never asked; only their hooks can stop", async () => {
  const hooked = agent("autosave-hooked");
  continuityEvent(workspace, hooked.agent_id, { session_id: "claude_code:autosave", project: "/autosave", runtime: "claude_code", event: "progress",
    messages: [{ id: "a1", role: "user", content: "Синтетика." }] });
  later(hooked);
  expect(instructions(hooked)).not.toContain(AUTOSAVE_INSTRUCTION);
  expect((await call(hooked, "recall", { query: "anything" })).autosave).toBeUndefined();
  const codex = agent("autosave-codex");
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-0000000a0518',?,?,?,'codex','read_write','autosave-test','verified','x','2999-01-01','2026-01-01')`).run(workspace, owner, codex.agent_id);
  expect((await call(codex, "recall", { query: "anything" })).autosave).toBeUndefined();
  // A memory client's own agent reads over its key before Codex trusts the hooks: not asked either.
  const memory = agent("autosave-memory-client");
  db.query("UPDATE agents SET metadata=json_set(metadata,'$.memory_client','codex') WHERE id=?").run(memory.agent_id);
  expect(autosaveReminder(workspace, memory.agent_id)).toBeUndefined();
  expect(agentContractFor(db, workspace, memory.agent_id, authorityOperations)!.mechanisms.find((m) => m.id === "memory.continuity")!.status).toBe("needs_setup");
  // The built-in agent saves when a run ends: a long run with tool calls is not a stopped capture.
  const builtIn = agent("autosave-built-in");
  saveMessage({ workspace_id: workspace, agent_id: builtIn.agent_id, session_id: "autosave-built-in", role: "user", content: "Синтетика.", capture: "qoopia_agent" });
  db.query("UPDATE session_messages SET created_at='2026-01-01T00:00:00Z' WHERE agent_id=?").run(builtIn.agent_id);
  noteAgentWork(builtIn.agent_id, "recall");
  expect(agentMemoryStatus(workspace, builtIn.agent_id).error_code).toBeNull();
  await expect(call(codex, "session_save", { user: "x", role: "user", content: "x" })).rejects.toThrow("INVALID_INPUT");
  await expect(call(codex, "session_save", { role: "user", content: "x" })).rejects.toThrow("INVALID_INPUT");
});
