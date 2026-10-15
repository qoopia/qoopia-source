// Audit 5.0.21 direction 4 (dashboard UX): errors in words, owner-only pages, addresses, accessibility.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dashboardPage, dashboardScript, dashboardStyles } from "./helpers/dashboard-source.ts";

const ru: Record<string, string> = JSON.parse(readFileSync(new URL("../src/public/brand/i18n.ru.json", import.meta.url), "utf8"));
const between = (from: string, to: string) => {
  const start = dashboardScript.indexOf(from), end = dashboardScript.indexOf(to, start);
  if (start < 0 || end < 0) throw Error("dashboard marker moved: " + from);
  return dashboardScript.slice(start, end);
};
// A Russian page: QI.msg translates through the catalog, as the runtime does.
const QI = { msg: (s: string, p: Record<string, unknown> = {}) => (ru[s] ?? s).replace(/\{(\w+)\}/g, (_, k) => String(p[k])), resolve: String };
const errors = runInNewContext(between("  function failure(r, data) {", "  async function api(path) {") + between("  // ---------- Errors ----------", "  function errBox(") + ";({failure,errReason})", { QI });
const response = (status: number) => ({ status, headers: { get: () => null } });

test("A4-03: a server sentence is shown in the page language; a bare code never is", () => {
  expect(errors.failure(response(409), { error_description: "Your agent is stopping. Wait for confirmation." }).message).toBe("Агент останавливается. Дождитесь подтверждения.");
  expect(errors.failure(response(500), { error: "internal_error", code: "INTERNAL" }).message).toBe(ru["The server could not complete the request."]);
  expect(dashboardScript).not.toMatch(/r\.next_action\|\|r\.code|e\.code \+ ': '/);
  expect(dashboardScript).toContain("status(QI.msg('A private draft was added to For sending.");
});

test("A4-04: 403 says the page belongs to the owner; agents do not list Bridges or External folder", () => {
  expect(errors.errReason({ status: 403 })).toBe("Это доступно только владельцу пространства.");
  expect(dashboardScript).toContain("const OWNER_PAGES=['work','connections','bridges','external'];");
});

test("A4-11: Memory, Connections and the owner panel fail like every other page; an ended session says so", () => {
  expect(dashboardScript).not.toMatch(/main\.innerHTML='<p role="alert">'\+esc\(e\.message\)/);
  for (const what of ["Could not load memory settings.", "Could not load connections.", "Could not load the owner dashboard."]) expect(dashboardScript).toContain("errBox(" + (what === "Could not load the owner dashboard." ? "view" : "main") + ",QI.msg('" + what + "')");
  expect(dashboardScript.match(/showLogin\(true\); throw new Error\('unauthorized'\)/g)?.length).toBe(2);
  expect(ru["Your session has ended. Sign in again."]).toBeString();
});

test("A4-19: no owner's agent names or model ids in the dashboard; the server names the memory model", async () => {
  expect(dashboardScript + dashboardStyles).not.toMatch(/\b(alan|aizek|aidan|liam)\b|claude-haiku|gpt-5\.6/i);
  const tones = runInNewContext(between("  function avatarClass(name) {", "  function initial(name)") + ";avatarClass", {});
  expect(tones("Alan")).toMatch(/^tone-[0-2]$/);
  expect(tones("Alan")).toBe(tones("Alan"));
  const { memoryModelLabel } = await import("../src/services/memory-model.ts");
  expect([memoryModelLabel("claude-haiku-4-5"), memoryModelLabel("gpt-5.6-luna"), memoryModelLabel("claude-opus-9"), memoryModelLabel(null)]).toEqual(["Claude · Haiku", "ChatGPT · Luna", "Claude · Opus", null]);
});

test("A4-05: an agent, its tab, a session and a conversation have an address that parses back", () => {
  const nav = runInNewContext(between("  function drillHash(page, d) {", "  function openDrill(") + ";({drillHash,parseDrillHash})", {});
  const agent = { id: "a/1 ü" }, pair = { agent_a: { id: "x" }, agent_b: { id: "y" } };
  expect(nav.drillHash("agents", { kind: "agent", agent, tab: "sessions" })).toBe("agents/a%2F1%20%C3%BC");
  expect(nav.parseDrillHash(nav.drillHash("agents", { kind: "agent", agent, tab: "access" }))).toEqual({ kind: "agent", agent: "a/1 ü", tab: "access" });
  expect(nav.parseDrillHash(nav.drillHash("agents", { kind: "session", agent, session: { id: "s1" } }))).toEqual({ kind: "session", agent: "a/1 ü", session: "s1" });
  expect(nav.parseDrillHash(nav.drillHash("agentcomm", { kind: "acthread", pair }))).toEqual({ kind: "acthread", a: "x", b: "y" });
  expect(nav.parseDrillHash("agents")).toBeNull();
  expect(nav.parseDrillHash("agents/%E0%A4%A")).toBeNull();
  // Every drill-down writes the address (pushState); none only swaps state.
  expect(between("  function drillAgentById(id) {", "  // ================= AGENT DETAIL")).toContain("openDrill(");
  expect(dashboardScript).not.toMatch(/state = \{ page: '(agents|agentcomm)', drill: \{[^}]*\} \};\s*route\(\)/);
});

test("A4-07: a skill card shows its real state; statuses, evidence and scopes are words", () => {
  const skills = runInNewContext(between("  const SKILL_WORDS", "  const loopUrl") + ";({SKILL_WORDS,skillWord,skillCardState})", { QI: { ...QI, code: String } });
  for (const word of Object.values(skills.SKILL_WORDS) as string[]) expect(ru[word], word).toBeString();
  const loop = { versions: [{ id: "v1", skill_id: "a", status: "sealed" }, { id: "v2", skill_id: "b", status: "candidate" }, { id: "v3", skill_id: "c", status: "sealed" }],
    assignments: [{ version_id: "v3", desired_state: "active" }] };
  expect(["a", "b", "c", "d", "e"].map(id => skills.skillCardState({ id, draft_id: id === "d" ? "x" : null }, loop))).toEqual(["sealed", "candidate", "in_use", "draft", "imported"]);
  expect(skills.skillWord("human_accepted")).toBe("Подтверждено вами");
  const page = between("  async function renderSkillsPage() {", "  // ================= GLOBAL SEARCH");
  expect(page).not.toMatch(/esc\((v|o|a)\.(status|evidence_class|target_scope)\)|skillStatus\(loop\.capabilities\.limitation\)|QI\.msg\("Draft"\) \+ " "/);
});

test("A4-08 / A4-14: crumb links are real links; agent sections are a tab list", () => {
  for (const [, tag] of dashboardScript.matchAll(/(<a\b[^>]*>)/g)) expect(tag, tag).toMatch(/href=/);
  const detail = between("  function renderAgentDetail() {", "  // One contract for every agent");
  for (const part of ['role="tablist"', 'role="tab"', "aria-selected", "ArrowRight", 'role=\\"tabpanel\\"']) expect(detail).toContain(part);
});

test("A4-10 / A4-12 / A4-13 / A4-15 / A4-16 / A4-17: targets, text size, locked switches, motion, labels, terms", () => {
  // File actions are 44px on a phone; no text below 11px is set inline; a locked switch is not removed from the Tab order.
  expect(dashboardStyles).toMatch(/\.f-row \.btn-more \{ min-height:44px;/);
  expect(dashboardScript).not.toMatch(/font-size:\.7[0-8]rem/);
  expect(dashboardStyles).not.toContain(".qswitch:disabled");
  expect(dashboardScript).not.toMatch(/' disabled title="'/);
  expect(dashboardScript).not.toMatch(/behavior:\s*'smooth'/);
  expect(dashboardScript).not.toMatch(/\$\('#(gSearch|searchInp)'\); inp\.focus\(\)/);
  expect(dashboardPage).toContain('aria-label="Main menu"');
  expect(dashboardPage).not.toMatch(/aria-label="(English|Русский)"/);
  // One Russian word for the steward role; "Мой агент Qoopia", not "Мой Qoopia агент".
  expect(Object.values(ru).filter(v => /стюард|Qoopia агент|Qoopia[а-я]/i.test(v))).toEqual([]);
});
