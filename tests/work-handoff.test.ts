/**
 * 5.0.23: work done in a project by one runtime reaches the next session there in the other runtime
 * (Codex → Claude Code), as bounded history and never as instructions; claims mark work as taken,
 * expire and are released, and take nothing over.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, setSharedContext } from "../src/admin/agents.ts";
import { checkpointSession, continuityEvent, projectHandoff, sessionFacts } from "../src/services/continuity.ts";
import { claimWork, openClaims, releaseWork } from "../src/services/work.ts";
import { findTool } from "../src/mcp/tools.ts";

let ws = "", slug = "", owner = "", steward = "", claude = "", codex = "", isolated = "", foreign = "";
const project = "/Users/example/Code/shop";
beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Work handoff", slug: "work-handoff-523" }); ws = w.id; slug = w.slug;
  owner = createAgent({ name: "handoff-owner", workspaceSlug: slug, type: "owner" }).id;
  steward = createAgent({ name: "handoff-steward", workspaceSlug: slug, type: "steward" }).id;
  claude = createAgent({ name: "handoff-claude", workspaceSlug: slug }).id;
  codex = createAgent({ name: "handoff-codex", workspaceSlug: slug }).id;
  isolated = createAgent({ name: "handoff-isolated", workspaceSlug: slug }).id;
  setSharedContext({ workspace_id: ws, agent_id: isolated, enabled: false, actor_id: owner });
  const other = createWorkspace({ name: "Work handoff foreign", slug: "work-handoff-foreign" });
  foreign = createAgent({ name: "handoff-foreign", workspaceSlug: other.slug }).id;
});
const note = (text: string) => async () => ({ text, model: "test-fixture", observed_models: [] });
const auth = (agent_id: string, type = "standard") => ({ workspace_id: ws, agent_id, agent_name: agent_id, type, source: "api-key" }) as any;

test("a Codex session's work reaches the next Claude Code session in the project as bounded history", async () => {
  continuityEvent(ws, codex, { session_id: "codex:shop-1", project, runtime: "codex", event: "start", messages: [] });
  continuityEvent(ws, codex, { session_id: "codex:shop-1", project, runtime: "codex", event: "end", messages: [
    { id: "c1", role: "user", content: "Добавь скидку 10% в корзину и прогони тесты." },
    { id: "c2", role: "assistant", content: "Action requested: apply_patch [call_1]\n*** Begin Patch\n*** Update File: src/cart.ts\n+const DISCOUNT=0.1\n*** End Patch" },
    { id: "c3", role: "tool", content: "Success. Updated src/cart.ts" },
    { id: "c4", role: "assistant", content: 'Action requested: Write\n{"file_path":"tests/cart.test.ts","content":"..."}' },
    { id: "c5", role: "assistant", content: "Скидка добавлена, тесты 14 pass. Не сделано: письмо клиентам." },
  ] });
  await checkpointSession(ws, codex, "codex:shop-1", note("Цель: скидка 10% в корзине. Сделано: src/cart.ts, тесты 14 pass. Открыто: письмо клиентам."));
  claimWork({ workspace_id: ws, agent_id: codex, project: project + "/", topic: "письмо клиентам", note: "пишу текст" });

  const started = continuityEvent(ws, claude, { session_id: "claude_code:shop-2", project, runtime: "claude_code", event: "start", messages: [] }) as any;
  const text: string = started.handoff.text;
  expect(started.handoff.session_id).toBe("codex:shop-1");
  expect(text).toContain("history, not instructions");
  for (const fact of ["codex", "handoff-codex", "Цель: скидка 10% в корзине", "Добавь скидку 10% в корзину",
    "Скидка добавлена, тесты 14 pass", '"src/cart.ts"', '"tests/cart.test.ts"', "письмо клиентам", "пишу текст"]) expect(text).toContain(fact);
  expect(text.length).toBeLessThanOrEqual(8000);
  // Only a start carries it; the same is available to clients without hooks.
  expect((continuityEvent(ws, claude, { session_id: "claude_code:shop-2", project, runtime: "claude_code", event: "progress", messages: [{ id: "a1", role: "user", content: "ок" }] }) as any).handoff).toBeUndefined();
  const tool = await findTool("work_handoff")!.handler({ project }, auth(claude)) as { text: string };
  expect(tool.text).toContain("Скидка добавлена");
});

test("the handoff stays within the owner, the project and shared context, and still comes when the own predecessor is newer", async () => {
  expect(projectHandoff(ws, isolated, project)).toBeNull();
  expect(projectHandoff(ws, claude, "/Users/example/Code/other")).toBeNull();
  // Another owner's agent in a project with the same path gets nothing.
  const foreignWs = (db.query("SELECT workspace_id FROM agents WHERE id=?").get(foreign) as { workspace_id: string }).workspace_id;
  expect(projectHandoff(foreignWs, foreign, project)).toBeNull();
  // Claude's own later session in the project ran beside the Codex work and ended after it: the live test of
  // 23.10.2026 got no handoff here. The other runtime's work still comes, said to be older than the own session.
  continuityEvent(ws, claude, { session_id: "claude_code:shop-2", project, runtime: "claude_code", event: "end", messages: [{ id: "a2", role: "user", content: "Готово." }] });
  db.query("UPDATE sessions SET last_active=? WHERE id='claude_code:shop-2'").run(new Date(Date.now() + 1000).toISOString());
  db.query("UPDATE session_messages SET created_at=? WHERE session_id='claude_code:shop-2'").run(new Date(Date.now() + 1000).toISOString());
  const next = continuityEvent(ws, claude, { session_id: "claude_code:shop-3", project, runtime: "claude_code", event: "start", previous_session_id: "claude_code:shop-2", messages: [] }) as any;
  expect(next.handoff.session_id).toBe("codex:shop-1");
  expect(next.handoff.text).toContain("Your own previous session in this project is newer than this work.");
  // The claim is still shown: it is current, whoever worked last.
  expect(next.handoff.text).toContain("письмо клиентам");
});

test("a claim marks work as taken: renewed by its holder, reported to others, released or expired, never taken over", () => {
  const first = claimWork({ workspace_id: ws, agent_id: claude, project, topic: "релиз 5.0.23", minutes: 30 });
  expect(first).toMatchObject({ claimed: true, renewed: false });
  const id = (first as { claim: { id: string } }).claim.id;
  expect(claimWork({ workspace_id: ws, agent_id: claude, project, topic: "релиз 5.0.23", minutes: 60 })).toMatchObject({ claimed: true, renewed: true });
  expect(claimWork({ workspace_id: ws, agent_id: codex, project, topic: "релиз 5.0.23" })).toMatchObject({ claimed: false, held_by: { agent: "handoff-claude", id } });
  expect(() => releaseWork({ workspace_id: ws, actor: { agent_id: codex, type: "standard" }, id })).toThrow("Only the agent holding a claim");
  expect(releaseWork({ workspace_id: ws, actor: { agent_id: steward, type: "steward" }, id })).toMatchObject({ released: true });
  expect(releaseWork({ workspace_id: ws, actor: { agent_id: claude, type: "standard" }, id })).toMatchObject({ released: false, state: "already_released" });
  expect(claimWork({ workspace_id: ws, agent_id: codex, project, topic: "релиз 5.0.23" })).toMatchObject({ claimed: true });
  // An expired claim is not open any more and frees the topic.
  db.query("UPDATE work_claims SET expires_at_ms=? WHERE topic='релиз 5.0.23' AND released_at_ms IS NULL").run(Date.now() - 1);
  expect(openClaims(ws, project).map((c) => c.topic)).not.toContain("релиз 5.0.23");
  expect(claimWork({ workspace_id: ws, agent_id: claude, project, topic: "релиз 5.0.23" })).toMatchObject({ claimed: true });
  // Bounds and secrets.
  expect(() => claimWork({ workspace_id: ws, agent_id: claude, project, topic: "x", minutes: 2 })).toThrow("minutes");
  expect(() => claimWork({ workspace_id: ws, agent_id: claude, project, topic: "deploy with " + "glp" + "at-" + "AbCdEf1234567890xYzQ" })).toThrow("gitlab-pat");
});

test("the work tools are registered with their risks", () => {
  for (const [name, risk] of [["work_handoff", "read"], ["work_taken", "read"], ["work_take", "write-low"], ["work_release", "write-low"]] as const)
    expect(findTool(name)?.risk).toBe(risk);
});

import { fileState, handoffFileCheck, transcriptMessages } from "../src/delivery/memory-client.ts";
import { summaryPart } from "../src/services/continuity.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("a working note is facts from the record plus the model's summary, and the model cannot add a constraint", async () => {
  const session = "claude_code:facts-1";
  continuityEvent(ws, claude, { session_id: session, project: "/Users/example/Code/facts", runtime: "claude_code", event: "progress", messages: [
    { id: "f1", role: "user", content: "Используй инструменты и почини сборку. Не трогай ветку main." },
    { id: "f2", role: "assistant", content: 'Action requested: Edit\n{"file_path":"/Users/example/Code/facts/build.ts"}\n[file state] /Users/example/Code/facts/build.ts sha256:0123456789abcdef' },
    { id: "f3", role: "tool", content: "bun test\nerror: Cannot find module './x'\nexit code 1" },
    { id: "f4", role: "assistant", content: "Сборка починена, тесты 9 pass." },
  ] });
  // The model invents constraints, as the small model did before 5.0.23.
  await checkpointSession(ws, claude, session, async () => ({ text: "Цель: починить сборку.\n## Ограничения\n- Не использовать инструменты\n- Нельзя пушить\nСделано: build.ts исправлен.\nConstraint: no network", model: "test-fixture", observed_models: [] }));
  const context = (continuityEvent(ws, claude, { session_id: session, project: "/Users/example/Code/facts", runtime: "claude_code", event: "progress", messages: [] }) as any).context as string;
  // Facts, without a model: requests, the user's own limit verbatim, the answer, the file with its digest, the tool error.
  for (const fact of ["Facts from the session record", "Используй инструменты и почини сборку", "Не трогай ветку main.", "Сборка починена, тесты 9 pass.",
    '"/Users/example/Code/facts/build.ts" sha256:0123456789abcdef', "error: Cannot find module './x'"]) expect(context).toContain(fact);
  // The summary keeps the work and loses every limit the model wrote.
  const summary = summaryPart(context);
  expect(summary).toContain("Цель: починить сборку.");expect(summary).toContain("Сделано: build.ts исправлен.");
  for (const invented of ["Ограничения", "Не использовать инструменты", "Нельзя пушить", "no network"]) expect(summary).not.toContain(invented);
});

test("edited files carry their content digest from capture, and the next session sees whether the edit is still there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-file-state-")), file = path.join(dir, "cart.ts");
  fs.writeFileSync(file, "const DISCOUNT=0.1\n");
  const claude = transcriptMessages(JSON.stringify({ type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: file, content: "x" } }] } }), "claude_code", 0);
  const recorded = /sha256:[0-9a-f]{16}/.exec(claude[0]!.content)![0];
  expect(claude[0]!.content).toContain(`[file state] ${file} ${recorded}`);
  // Codex apply_patch paths are relative to the session's directory.
  const codex = transcriptMessages(JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: "*** Begin Patch\n*** Update File: cart.ts\n*** End Patch" } }), "codex", 0, dir);
  expect(codex[0]!.content).toContain(`[file state] cart.ts ${recorded}`);
  expect(fileState(["absent.ts"], dir)).toBe("\n[file state] absent.ts missing");
  expect(handoffFileCheck([{ path: file, state: recorded }], dir)).toContain("unchanged since that session");
  fs.writeFileSync(file, "const DISCOUNT=0.2\n");
  expect(handoffFileCheck([{ path: file, state: recorded }], dir)).toContain("changed since that session");
  fs.rmSync(file);
  expect(handoffFileCheck([{ path: file, state: recorded }], dir)).toContain("missing now");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("handoff sections give way by priority: marks and the final answer survive a very long summary", async () => {
  const p = "/Users/example/Code/budget";
  continuityEvent(ws, codex, { session_id: "codex:budget-1", project: p, runtime: "codex", event: "end", messages: [
    { id: "b1", role: "user", content: "Сделай большой рефакторинг." }, { id: "b2", role: "assistant", content: "Итог: рефакторинг готов." }] });
  await checkpointSession(ws, codex, "codex:budget-1", note("Шаг. ".repeat(3000)));
  claimWork({ workspace_id: ws, agent_id: codex, project: p, topic: "рефакторинг модуля оплаты" });
  const handoff = projectHandoff(ws, claude, p)!;
  expect(handoff.text.length).toBeLessThanOrEqual(8000);
  expect(handoff.text).toContain("рефакторинг модуля оплаты");
  expect(handoff.text).toContain("Итог: рефакторинг готов.");
  expect(handoff.text.indexOf("Open marks")).toBeLessThan(handoff.text.indexOf("final answer"));
  expect(handoff.text.indexOf("final answer")).toBeLessThan(handoff.text.indexOf("working summary"));
});

test("the memory mirror writes a read-only Markdown copy of the notes in force, and edits to it change nothing", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-mirror-")), "mirror");
  const kept = (db.query("SELECT COUNT(*) AS n FROM notes WHERE workspace_id=? AND deleted_at IS NULL AND invalidated_at_ms IS NULL").get(ws) as { n: number }).n;
  const run = Bun.spawnSync([process.execPath, "scripts/memory-mirror.ts", "--workspace", slug, "--out", out], { env: process.env });
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout.toString())).toMatchObject({ notes: kept });
  const index = fs.readFileSync(path.join(out, "index.md"), "utf8");
  expect(index).toContain("Editing these files changes nothing in Qoopia.");
  const files = [...new Bun.Glob("**/*.md").scanSync(out)].filter((f) => f !== "index.md");
  expect(files).toHaveLength(kept);
  const one = path.join(out, files[0]!);
  expect(fs.statSync(one).mode & 0o777).toBe(0o400);
  expect(fs.readFileSync(one, "utf8")).toMatch(/^---\nid: /);
  // A mirror is never written over another.
  expect(Bun.spawnSync([process.execPath, "scripts/memory-mirror.ts", "--workspace", slug, "--out", out], { env: process.env }).exitCode).not.toBe(0);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

describe("live test of 23.10.2026: Codex Desktop → Claude Code", () => {
  const p = "/Users/example/Code/handoff-live";
  test("1. an app-generated request is not conversation: not stored, a service session, never a handoff source or a note", async () => {
    continuityEvent(ws, codex, { session_id: "codex:live-work", project: p, runtime: "codex", event: "start", messages: [] });
    continuityEvent(ws, codex, { session_id: "codex:live-work", project: p, runtime: "codex", event: "progress", messages: [
      { id: "w1", role: "user", content: "Создай hello.txt и отчитайся." },
      { id: "w2", role: "assistant", content: 'Action requested: exec [call_9]\n{"code":"await tools.apply_patch(\\"*** Begin Patch\\\\n*** Add File: hello.txt\\\\n+hi\\\\n*** End Patch\\")"}\n[file state] hello.txt sha256:1111222233334444' },
      { id: "w3", role: "assistant", content: "Готов к обратному тесту: hello.txt создан." },
    ] });
    // Right after, Codex Desktop asks its model for a suggested next message in a session of its own.
    const service = continuityEvent(ws, codex, { session_id: "codex:live-suggest", project: p, runtime: "codex", event: "end", messages: [
      { id: "s1", role: "user", content: "This is an app-generated request for a suggested next user message. The user did not write this message." },
      { id: "s2", role: "assistant", content: '{"suggestion": "Запусти обратный тест"}' },
    ] }) as any;
    expect(service.accepted).toEqual(["s1", "s2"]);
    expect(db.query("SELECT COUNT(*) AS n FROM session_messages WHERE session_id='codex:live-suggest'").get()).toEqual({ n: 0 });
    expect(JSON.parse((db.query("SELECT metadata FROM sessions WHERE id='codex:live-suggest'").get() as { metadata: string }).metadata).continuity_service).toBe(1);
    expect(await checkpointSession(ws, codex, "codex:live-suggest", note("не должно быть"))).toMatchObject({ state: "unchanged" });
    const handoff = projectHandoff(ws, claude, p, undefined, "claude_code")!;
    expect(handoff.session_id).toBe("codex:live-work");
    expect(handoff.text).toContain("Готов к обратному тесту");expect(handoff.text).not.toContain("suggestion");
  });

  test("2. files edited by apply_patch inside code-mode exec are listed with their digest", () => {
    const handoff = projectHandoff(ws, claude, p, undefined, "claude_code")!;
    expect(handoff.files).toEqual([{ path: "hello.txt", state: "sha256:1111222233334444" }]);
    expect(handoff.text).toContain('"hello.txt" sha256:1111222233334444');
  });

  test("3. at Claude Code start the other runtime's last real work comes, even beside a newer own predecessor and an app request", () => {
    // The owner's earlier Claude session in the project ran beside Codex and ended after it (its hooks moved last_active).
    continuityEvent(ws, claude, { session_id: "claude_code:live-own", project: p, runtime: "claude_code", event: "end", messages: [{ id: "o1", role: "user", content: "жду Codex" }] });
    db.query("UPDATE sessions SET last_active=? WHERE id='claude_code:live-own'").run(new Date(Date.now() + 60_000).toISOString());
    const started = continuityEvent(ws, claude, { session_id: "claude_code:live-next", project: p, runtime: "claude_code", event: "start", previous_session_id: "claude_code:live-own", messages: [] }) as any;
    expect(started.handoff.session_id).toBe("codex:live-work");
    expect(started.handoff.text).toContain("Готов к обратному тесту");
    expect(started.handoff.files.length).toBeGreaterThan(0);
  });

  test("4. a summary older than the last answer is marked, the answer and files go above it, and the summary is queued", async () => {
    await checkpointSession(ws, codex, "codex:live-work", note("Цель: hello.txt."));
    continuityEvent(ws, codex, { session_id: "codex:live-work", project: p, runtime: "codex", event: "progress", messages: [
      { id: "w4", role: "user", content: "Добавь строку в hello.txt." }, { id: "w5", role: "assistant", content: "Строка добавлена, финал." }] });
    const handoff = projectHandoff(ws, claude, p, undefined, "claude_code")!;
    expect(handoff.text).toContain("older than its last answer");
    expect(handoff.text).toContain("Строка добавлена, финал.");
    expect(handoff.text.indexOf("final answer")).toBeLessThan(handoff.text.indexOf("working summary"));
    expect(handoff.text.indexOf("Files it changed")).toBeLessThan(handoff.text.indexOf("working summary"));
    expect(JSON.parse((db.query("SELECT metadata FROM sessions WHERE id='codex:live-work'").get() as { metadata: string }).metadata).continuity_priority).toBe(1);
    // Once the summary covers the last turns, it is no longer marked.
    await checkpointSession(ws, codex, "codex:live-work", note("Цель: hello.txt. Финал: строка добавлена."));
    expect(projectHandoff(ws, claude, p, undefined, "claude_code")!.text).not.toContain("older than its last answer");
  });

  test("5. MacBook rerun: files a shell command wrote come from the working-tree report; Codex's AGENTS.md text is no request", () => {
    const q = "/Users/example/Code/handoff-exec";
    // An injected AGENTS.md turn alone is not work: such a session never becomes the handoff.
    continuityEvent(ws, codex, { session_id: "codex:exec-empty", project: q, runtime: "codex", event: "end", messages: [
      { id: "e1", role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>" }] });
    expect(projectHandoff(ws, claude, q, undefined, "claude_code")).toBeNull();
    continuityEvent(ws, codex, { session_id: "codex:exec-work", project: q, runtime: "codex", event: "end", messages: [
      { id: "x1", role: "user", content: "<environment_context>\n<cwd>/x</cwd>\n</environment_context>" },
      { id: "x2", role: "user", content: "Write plan.md and finish app.txt." },
      { id: "x3", role: "assistant", content: 'Action requested: exec [call_1]\n{"code":"python3 -c \\"open(\'plan.md\',\'w\')\\""}' },
      { id: "x4", role: "assistant", content: "Codex finished LIVE" },
      { id: "x5", role: "tool", content: "[workspace changes] Files in this directory's git working tree that changed since this session started (another program's edits meanwhile are included):\n[file state] app.txt sha256:aaaabbbbccccdddd\n[file state] src/errors.ts sha256:1234123412341234" },
    ] });
    const handoff = projectHandoff(ws, claude, q, undefined, "claude_code")!;
    expect(handoff.session_id).toBe("codex:exec-work");
    expect(handoff.files).toEqual([{ path: "app.txt", state: "sha256:aaaabbbbccccdddd" }, { path: "src/errors.ts", state: "sha256:1234123412341234" }]);
    expect(handoff.text).toContain('"Codex finished LIVE"');
    expect(handoff.text).not.toContain("AGENTS.md instructions");expect(handoff.text).not.toContain("environment_context");
    // A file name is not a tool error.
    expect(sessionFacts(ws, codex, "codex:exec-work").errors).toEqual([]);
    expect(sessionFacts(ws, codex, "codex:exec-work").requests).toEqual(["Write plan.md and finish app.txt."]);
  });

  test("6. a tool error is a line that reports one, not the word «error» inside printed text", () => {
    const out = (id: string, content: string) => ({ id, role: "tool" as const, content: "Result for call:\n" + content });
    continuityEvent(ws, codex, { session_id: "codex:errors", project: "/Users/example/Code/errs", runtime: "codex", event: "end", messages: [
      { id: "r1", role: "user", content: "Проверь." },
      out("r2", 'Script completed\n{"chunk_id":"a","exit_code":0,"output":"If a call fails, follow the error fallback."}'),
      out("r3", "Use --error-message when the outcome is error."),
      out("r4", "fatal: not a git repository (or any of the parent directories): .git"),
      out("r5", '{"chunk_id":"b","exit_code":2,"output":"rg: x"}'),
      out("r6", "TypeError: cannot read properties of undefined"),
    ] });
    expect(sessionFacts(ws, codex, "codex:errors").errors).toEqual([
      "fatal: not a git repository (or any of the parent directories): .git", '{"chunk_id":"b","exit_code":2,"output":"rg: x"}', "TypeError: cannot read properties of undefined"]);
  });
});
