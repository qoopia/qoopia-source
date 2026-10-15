/**
 * Canon (5.0.21): rules the server loads into an agent's context by itself — brief, the memory
 * hook (session start and every user turn), AgentComm wakes — with history by supersede, a
 * journal of where each canon went, and a fixed import of rule notes.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { brief } from "../src/services/brief.ts";
import { pruneCanonApplications,
  canonHookRequest, createCanon, getCanon, importRuleCanons, listCanons, retireCanon, ruleSimilarity, scoreCanon,
  selectCanons, stems, suggestTriggers, updateCanon,
} from "../src/services/canon.ts";
import { findTool } from "../src/mcp/tools.ts";

let WS = "", A = "", B = "", STEWARD = "";
const a = () => ({ agent_id: A, type: "standard" });
const b = () => ({ agent_id: B, type: "standard" });
const steward = () => ({ agent_id: STEWARD, type: "steward" });

beforeAll(() => {
  runMigrations();
  WS = createWorkspace({ name: "Canon", slug: "canon-ws" }).id;
  A = createAgent({ name: "canon-alpha", workspaceSlug: "canon-ws" }).id;
  B = createAgent({ name: "canon-beta", workspaceSlug: "canon-ws" }).id;
  STEWARD = createAgent({ name: "canon-steward", workspaceSlug: "canon-ws", type: "steward" }).id;
});

const code = (fn: () => unknown) => { try { fn(); return "OK"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe("writing canons", () => {
  test("an agent's canon suggests triggers from its own words, files and tools", () => {
    const r = createCanon({ workspace_id: WS, actor: a(), text: "Перед деплоем на Corsair всегда делай бэкап базы и проверяй docker ps." });
    expect(r.canon.scope).toBe("agent");
    expect(r.canon.agent_id).toBe(A);
    expect(r.canon.mode).toBe("contextual");
    expect(r.canon.triggers.words.length).toBeGreaterThan(0);
    expect(r.canon.triggers.tools).toContain("docker");
    expect(suggestTriggers("Edit AGENTS.md before you run git push").files).toContain("agents.md");
  });

  test("the same rule reworded replaces the old canon; the history keeps it", () => {
    const first = createCanon({ workspace_id: WS, actor: a(), text: "Отвечай Асхату коротко, без воды и без вступлений." }).canon;
    const second = createCanon({ workspace_id: WS, actor: a(), text: "Отвечай Асхату коротко, без воды, без вступлений и пересказа." });
    expect(second.replaced).toBe(first.id);
    const old = getCanon({ workspace_id: WS, actor: a(), id: first.id }).canon;
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(second.canon.id);
    expect(getCanon({ workspace_id: WS, actor: a(), id: second.canon.id }).history.map((h) => h.id)).toEqual([first.id]);
  });

  test("a related but different rule is not guessed at: CONFLICT with candidates, then an explicit choice", () => {
    createCanon({ workspace_id: WS, actor: b(), text: "Коммиты пиши на английском, коротко, с причиной изменения." });
    let error: { code?: string; details?: { candidates?: unknown[] } } = {};
    try { createCanon({ workspace_id: WS, actor: b(), text: "Коммиты подписывай строкой Co-Authored-By, на английском." }); } catch (e) { error = e as typeof error; }
    expect(error.code).toBe("CONFLICT");
    expect(error.details?.candidates?.length).toBeGreaterThan(0);
    const kept = createCanon({ workspace_id: WS, actor: b(), text: "Коммиты подписывай строкой Co-Authored-By, на английском.", on_conflict: "keep_both" });
    expect(kept.kept_alongside?.length).toBe(1);
    expect(listCanons({ workspace_id: WS, actor: b(), agent: "canon-beta", scope: "agent" }).total).toBe(2);
  });

  test("workspace canons bind everyone: only the steward or the owner writes them", () => {
    expect(code(() => createCanon({ workspace_id: WS, actor: a(), text: "Все агенты пишут по-русски.", scope: "workspace" }))).toBe("FORBIDDEN");
    const ws = createCanon({ workspace_id: WS, actor: steward(), text: "Все агенты пишут владельцу по-русски.", mode: "always" }).canon;
    expect(ws.scope).toBe("workspace");
    expect(code(() => retireCanon({ workspace_id: WS, actor: a(), id: ws.id }))).toBe("FORBIDDEN");
    expect(code(() => createCanon({ workspace_id: WS, actor: a(), text: "Бета никогда не трогает прод.", agent: "canon-beta" }))).toBe("FORBIDDEN");
  });

  test("another agent's own canon is not readable; the workspace's is", () => {
    const secret = createCanon({ workspace_id: WS, actor: b(), text: "Бета проверяет логи nginx раз в час." }).canon;
    expect(code(() => getCanon({ workspace_id: WS, actor: a(), id: secret.id }))).toBe("NOT_FOUND");
    expect(getCanon({ workspace_id: WS, actor: steward(), id: secret.id }).canon.id).toBe(secret.id);
    expect(listCanons({ workspace_id: WS, actor: a() }).items.every((c) => c.scope !== "agent" || c.agent_id === A)).toBe(true);
  });

  test("new text is a new version; mode and triggers change in place; retire stops loading", () => {
    const c = createCanon({ workspace_id: WS, actor: a(), text: "Секреты никогда не выводи в чат и в логи.", triggers: { words: ["секрет"] } }).canon;
    const moved = updateCanon({ workspace_id: WS, actor: a(), id: c.id, mode: "always" }).canon;
    expect(moved.id).toBe(c.id);
    expect(moved.mode).toBe("always");
    const reworded = updateCanon({ workspace_id: WS, actor: a(), id: c.id, text: "Секреты и токены никогда не выводи в чат, логи и заметки." }).canon;
    expect(reworded.id).not.toBe(c.id);
    expect(reworded.supersedes_id).toBe(c.id);
    expect(reworded.mode).toBe("always");
    retireCanon({ workspace_id: WS, actor: a(), id: reworded.id, reason: "covered by the workspace canon" });
    expect(selectCanons({ workspace_id: WS, agent_id: A, surface: "match", record: false }).always.map((m) => m.canon.id)).not.toContain(reworded.id);
  });

  test("manual memory: an agent's canon waits for the owner, like a skill", () => {
    const manual = createAgent({ name: "canon-manual", workspaceSlug: "canon-ws" }).id;
    db.query("UPDATE agents SET memory_mode='manual' WHERE id=?").run(manual);
    expect(code(() => createCanon({ workspace_id: WS, actor: { agent_id: manual, type: "standard" }, text: "Пиши тесты к каждому исправлению." }))).toBe("APPROVAL_REQUIRED");
  });

  test("secrets and oversize text are refused", () => {
    expect(code(() => createCanon({ workspace_id: WS, actor: a(), text: "x".repeat(2001) }))).toBe("SIZE_LIMIT");
    expect(code(() => createCanon({ workspace_id: WS, actor: a(), text: "Use key sk-ant-api03-" + "a".repeat(90) }))).not.toBe("OK");
  });
});

describe("selection", () => {
  let WS2 = "", C = "";
  beforeAll(() => {
    WS2 = createWorkspace({ name: "Canon select", slug: "canon-select" }).id;
    C = createAgent({ name: "canon-gamma", workspaceSlug: "canon-select" }).id;
    const st = createAgent({ name: "canon-select-steward", workspaceSlug: "canon-select", type: "steward" }).id;
    const g = { agent_id: C, type: "standard" };
    createCanon({ workspace_id: WS2, actor: { agent_id: st, type: "steward" }, text: "Владельца зовут Асхат.", mode: "always" });
    createCanon({ workspace_id: WS2, actor: g, text: "Миграции базы запускай только через bun run migrate после бэкапа.", triggers: { words: ["миграция", "migrate"] } });
    createCanon({ workspace_id: WS2, actor: g, text: "Сайт деплоится через Cloudflare Pages, CSP не ослаблять.", triggers: { words: ["сайт", "cloudflare"], files: ["_headers"] } });
  });

  test("always canons come every time; contextual ones only when the turn points at them", () => {
    const deploy = selectCanons({ workspace_id: WS2, agent_id: C, prompt: "Нужно прогнать миграцию базы на проде", surface: "prompt", record: false });
    expect(deploy.always.map((m) => m.canon.text)).toEqual(["Владельца зовут Асхат."]);
    expect(deploy.contextual.map((m) => m.canon.text)).toEqual(["Миграции базы запускай только через bun run migrate после бэкапа."]);
    expect(deploy.contextual[0]!.reasons.some((r) => r.startsWith("word:"))).toBe(true);
    const site = selectCanons({ workspace_id: WS2, agent_id: C, prompt: "поправь _headers на сайте", surface: "prompt", record: false, include_always: false });
    expect(site.always).toEqual([]);
    expect(site.contextual.map((m) => m.canon.text)).toEqual(["Сайт деплоится через Cloudflare Pages, CSP не ослаблять."]);
    expect(selectCanons({ workspace_id: WS2, agent_id: C, prompt: "какая сегодня погода", surface: "prompt", record: false }).contextual).toEqual([]);
  });

  test("meaning alone can bring a canon in, a weak echo cannot", () => {
    const row = { text: "Никогда не удаляй данные владельца без подтверждения.", triggers: "{}", project_id: null };
    const turn = { text: "убери старые записи", tokens: new Set(stems("убери старые записи")), places: [] };
    expect(scoreCanon(row, turn, 0.5).score).toBe(0);
    expect(scoreCanon(row, turn, 0.97).score).toBeGreaterThanOrEqual(2);
  });

  test("selection is recorded per turn: which canon, which agent, which surface and why", () => {
    const before = (db.query("SELECT COUNT(*) n FROM canon_applications WHERE agent_id=?").get(C) as { n: number }).n;
    selectCanons({ workspace_id: WS2, agent_id: C, prompt: "migrate база", surface: "prompt", session_id: "codex:s1" });
    const rows = db.query("SELECT surface, session_id, reason FROM canon_applications WHERE agent_id=? ORDER BY id").all(C) as { surface: string; session_id: string; reason: string }[];
    expect(rows.length - before).toBe(2);
    expect(rows.at(-1)!.surface).toBe("prompt");
    expect(rows.at(-1)!.session_id).toBe("codex:s1");
    const applied = db.query("SELECT applied_count, last_applied_at FROM canons WHERE workspace_id=? AND mode='always'").get(WS2) as { applied_count: number; last_applied_at: string };
    expect(applied.applied_count).toBeGreaterThan(0);
    expect(applied.last_applied_at).toBeTruthy();
  });

  test("brief carries the always canons; the memory hook gets always at start and contextual per prompt", async () => {
    const b2 = brief({ workspace_id: WS2, caller_agent_id: C, is_admin: false });
    expect((b2 as { canon?: { items: { text: string }[] } }).canon?.items.map((i) => i.text)).toEqual(["Владельца зовут Асхат."]);
    const start = await canonHookRequest(WS2, C, { event: "start", session_id: "claude_code:x", cwd: "/tmp/x" });
    expect(start.text).toContain("Владельца зовут Асхат.");
    expect(start.text).not.toContain("Миграции");
    const prompt = await canonHookRequest(WS2, C, { event: "prompt", session_id: "claude_code:x", prompt: "запусти migrate" });
    expect(prompt.text).toContain("Миграции базы");
    expect(prompt.text).not.toContain("Асхат");
    expect(await canonHookRequest(WS2, C, { event: "prompt", prompt: "привет" })).toEqual({ text: "", ids: [] });
    expect(() => canonHookRequest(WS2, C, { event: "prompt", extra: 1 } as never)).toThrow();
  });

  test("a session whose start brought no canon gets the always ones with its first prompt, once", async () => {
    const first = await canonHookRequest(WS2, C, { event: "prompt", session_id: "codex:silent-start", prompt: "привет" });
    expect(first.text).toContain("Владельца зовут Асхат.");
    const second = await canonHookRequest(WS2, C, { event: "prompt", session_id: "codex:silent-start", prompt: "привет ещё" });
    expect(second.text).not.toContain("Асхат");
  });

  test("at most five contextual canons, within the character budget", () => {
    const ws = createWorkspace({ name: "Canon many", slug: "canon-many" }).id;
    const d = createAgent({ name: "canon-delta", workspaceSlug: "canon-many" }).id;
    for (let i = 0; i < 8; i++) createCanon({ workspace_id: ws, actor: { agent_id: d, type: "standard" }, text: `Правило ${i}: релиз ${"проверяй ".repeat(i + 1)}${i}`, triggers: { words: ["релиз"] }, on_conflict: "keep_both" });
    expect(selectCanons({ workspace_id: ws, agent_id: d, prompt: "готовим релиз", surface: "prompt", record: false }).contextual.length).toBe(5);
  });
});

describe("rule import", () => {
  let WS3 = "", E = "", OWNER = "", PROJECT = "";
  beforeAll(() => {
    WS3 = createWorkspace({ name: "Canon import", slug: "canon-import" }).id;
    E = createAgent({ name: "canon-epsilon", workspaceSlug: "canon-import" }).id;
    OWNER = createAgent({ name: "canon-owner", workspaceSlug: "canon-import" }).id;
    db.query("UPDATE agents SET principal_kind='human' WHERE id=?").run(OWNER);
    db.query("INSERT INTO workspace_owners (id, workspace_id, actor_id, origin_instance_id, created_at_ms) VALUES ('wo-canon', ?, ?, 'test', ?)").run(WS3, OWNER, Date.now());
    PROJECT = "canon_proj";
    db.query("INSERT INTO notes (id, workspace_id, agent_id, type, text) VALUES (?, ?, ?, 'project', 'Happy Cake')").run(PROJECT, WS3, E);
    const rule = db.query("INSERT INTO notes (id, workspace_id, agent_id, type, text, tags, project_id, visibility, metadata, invalidated_at_ms, deleted_at) VALUES (?, ?, ?, 'rule', ?, ?, ?, ?, ?, ?, ?)");
    rule.run("r_agent", WS3, E, "Перед ответом проверяй факты в коде.", "[]", null, "workspace", "{}", null, null);
    rule.run("r_always", WS3, E, "Пиши без тире.", '["always"]', null, "workspace", "{}", null, null);
    rule.run("r_owner", WS3, OWNER, "GO нужен на траты и смену поставщиков.", "[]", null, "workspace", "{}", null, null);
    rule.run("r_tagged", WS3, E, "Отчёты выпусков кладём в ~/Code/qoopia.", '["canon:workspace"]', null, "workspace", "{}", null, null);
    rule.run("r_private", WS3, E, "Личное правило эпсилона.", '["canon:workspace"]', null, "private", "{}", null, null);
    rule.run("r_project", WS3, E, "Цены Happy Cake меняет только директор.", "[]", PROJECT, "workspace", "{}", null, null);
    rule.run("r_long", WS3, E, "д".repeat(2100), "[]", null, "workspace", "{}", null, null);
    rule.run("r_dup", WS3, E, "Перед ответом  проверяй факты в коде.", "[]", null, "workspace", "{}", null, null);
    rule.run("r_old", WS3, E, "Устаревшее правило.", "[]", null, "workspace", "{}", Date.now(), null);
    rule.run("r_deleted", WS3, E, "Удалённое правило.", "[]", null, "workspace", "{}", null, new Date().toISOString());
    rule.run("r_archived", WS3, E, "Архивное правило.", "[]", null, "workspace", '{"status":"archived"}', null, null);
  });

  test("a dry run plans by fixed rules and writes nothing", () => {
    const plan = importRuleCanons({ workspace_id: WS3 });
    expect(plan.committed).toBe(false);
    expect(plan.rules).toBe(8);
    const by = Object.fromEntries(plan.plan.map((i) => [i.note_id, i]));
    expect(by.r_agent).toMatchObject({ action: "import", scope: "agent", agent_id: E, mode: "contextual" });
    expect(by.r_always).toMatchObject({ action: "import", mode: "always" });
    expect(by.r_owner).toMatchObject({ action: "import", scope: "workspace", reason: "owner_rule" });
    expect(by.r_tagged).toMatchObject({ action: "import", scope: "workspace", reason: "tagged_workspace" });
    expect(by.r_private).toMatchObject({ action: "import", scope: "agent" });
    expect(by.r_project).toMatchObject({ action: "import", scope: "project", project_id: PROJECT });
    expect(by.r_long).toMatchObject({ action: "skip", reason: "too_long" });
    expect(by.r_dup).toMatchObject({ action: "skip", reason: "duplicate_text" });
    expect(plan.skipped).toEqual({ too_long: 1, duplicate_text: 1 });
    expect((db.query("SELECT COUNT(*) n FROM canons WHERE workspace_id=?").get(WS3) as { n: number }).n).toBe(0);
  });

  test("commit writes every planned canon once; a rerun adds nothing; the notes stay unchanged", () => {
    const before = db.query("SELECT id, text, metadata, updated_at FROM notes WHERE workspace_id=? ORDER BY id").all(WS3);
    const done = importRuleCanons({ workspace_id: WS3, commit: true });
    expect(done.import).toBe(6);
    const rows = db.query("SELECT source_note_id, source, scope, mode FROM canons WHERE workspace_id=? ORDER BY source_note_id").all(WS3) as { source_note_id: string; source: string }[];
    expect(rows.map((r) => r.source_note_id)).toEqual(["r_agent", "r_always", "r_owner", "r_private", "r_project", "r_tagged"]);
    expect(rows.every((r) => r.source === "rule_import")).toBe(true);
    const again = importRuleCanons({ workspace_id: WS3, commit: true });
    expect(again.import).toBe(0);
    expect(again.skipped.already_imported).toBe(6);
    expect(db.query("SELECT id, text, metadata, updated_at FROM notes WHERE workspace_id=? ORDER BY id").all(WS3)).toEqual(before);
  });

  test("imported project canons apply in that project only", () => {
    const outside = selectCanons({ workspace_id: WS3, agent_id: E, prompt: "кто меняет цены", surface: "prompt", record: false });
    expect(outside.contextual.map((m) => m.canon.text)).not.toContain("Цены Happy Cake меняет только директор.");
    const inside = selectCanons({ workspace_id: WS3, agent_id: E, prompt: "кто меняет цены", project: PROJECT, surface: "prompt", record: false });
    expect(inside.contextual.map((m) => m.canon.text)).toContain("Цены Happy Cake меняет только директор.");
  });
});

test("rule similarity counts shared significant words over the shorter rule", () => {
  expect(ruleSimilarity("Пиши коротко и без воды", "Пиши коротко, без воды")).toBe(1);
  expect(ruleSimilarity("Пиши коротко", "Делай бэкап перед миграцией")).toBe(0);
});

test("the canon tools are registered with their risk classes", () => {
  for (const [name, risk] of [["canon_create", "write-low"], ["canon_update", "write-low"], ["canon_retire", "write-low"], ["canon_list", "read"], ["canon_get", "read"], ["canon_match", "read"]] as const)
    expect(findTool(name)?.risk).toBe(risk);
});

test("maintenance keeps 90 days of the application journal", () => {
  const c = createCanon({ workspace_id: WS, actor: b(), text: "Журнал применений хранится девяносто дней.", mode: "always", on_conflict: "keep_both" }).canon;
  const now = Date.parse("2026-10-14T00:00:00Z");
  const add = (days: number) => db.query("INSERT INTO canon_applications (workspace_id, canon_id, agent_id, surface, reason, applied_at) VALUES (?, ?, ?, 'match', 'always', ?)")
    .run(WS, c.id, B, new Date(now - days * 86_400_000).toISOString());
  add(91); add(89);
  expect(pruneCanonApplications(now)).toBe(1);
  expect((db.query("SELECT count(*) AS n FROM canon_applications WHERE canon_id = ?").get(c.id) as { n: number }).n).toBe(1);
});
