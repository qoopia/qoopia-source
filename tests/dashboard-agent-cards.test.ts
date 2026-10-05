// F-322: agent activity is stated in words, not by a hover-only dot.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { dashboardScript } from "./helpers/dashboard-source.ts";

const between = (from: string, to: string) => {
  const start = dashboardScript.indexOf(from), end = dashboardScript.indexOf(to, start);
  if (start < 0 || end < 0) throw Error("dashboard marker moved: " + from);
  return dashboardScript.slice(start, end);
};
const utils = between("  function esc(s) {", "  // ---------- Navigation ----------");
const agents = between("  // ================= AGENTS PAGE =================", "  function drillAgentById(id) {");

function board() {
  const el: any = { classList: { remove() {} }, contains: () => false, querySelectorAll: () => [], querySelector: () => null };
  const ctx: any = { document: {}, window: {}, CSS: { escape: String }, setConn() {}, $: () => null, coverageLine: () => "", drillAgentById() {},
    QI: { msg: (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k])), relative: (n: number, u: string) => `${n} ${u}`, count: (n: number, u: string) => `${n} ${u}`, date: String, number: String, code: String, resolve: String } };
  runInNewContext(utils + agents, ctx);
  return { ctx, el };
}
const visibleText = (html: string) => html.replace(/<[^>]*>/g, " ");
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

test("an agent active 30 s ago says so in its visible text", () => {
  const { ctx } = board();
  expect(visibleText(ctx.agentCard({ id: "a", name: "alpha", type: "standard", last_seen: ago(30) }))).toContain("active now");
  expect(visibleText(ctx.agentCard({ id: "b", name: "beta", type: "standard", last_seen: ago(300) }))).toContain("active recently");
  const idle = visibleText(ctx.agentCard({ id: "c", name: "gamma", type: "standard", last_seen: ago(3600) }));
  expect(idle).not.toContain("active now");
  expect(idle).not.toContain("active recently");
});

test("an agent row carries both owner switches; a steward reads the whole workspace instead", () => {
  const { ctx } = board();
  const agent = (extra: Record<string, unknown>) => ({ id: "a", name: "alpha", type: "standard", last_seen: ago(30), memory: { mode: "auto", state: "working", revision: 0 }, ...extra });
  const owned = ctx.agentCard(agent({ shared_context: false, can_switch_shared_context: true, can_manage_memory: true }));
  expect(owned).toContain('data-switch="autosave"');
  expect(owned).toMatch(/data-switch="autosave"[^>]*aria-checked="true"/);
  expect(owned).toMatch(/data-switch="shared"[^>]*aria-checked="false"/);
  expect(owned).not.toContain(" disabled");
  // Without the owner's authority the switches stay visible but say why they cannot change.
  expect(ctx.agentCard(agent({ shared_context: true, can_switch_shared_context: false, can_manage_memory: false }))).toContain("disabled title=");
  const steward = ctx.agentCard(agent({ type: "steward", shared_context: null, can_manage_memory: true }));
  expect(steward).not.toContain('data-switch="shared"');
  expect(steward).toContain('data-switch="autosave"');
  expect(visibleText(steward)).toContain("Whole workspace");
  // The owner reads the whole workspace and needs no autosave: no switch, no memory state, a marked row.
  const owner = ctx.agentCard(agent({ type: "owner", shared_context: null, can_manage_memory: true }));
  expect(owner).not.toContain("data-switch");
  expect(owner).toContain("agent-row-owner");
  expect(visibleText(owner)).toContain("Whole workspace");
  // Saves waiting for the owner open the agent directly.
  expect(ctx.agentCard(agent({ memory: { mode: "manual", state: "manual", revision: 1, pending_saves: 2 } }))).toContain('data-open="a"');
});

test("the owner leads the list, then the steward, then each runtime in order, then the rest by activity", () => {
  const a = (id: string, extra: Record<string, unknown>, seen = 100) => ({ id, name: id, type: "standard", last_seen: ago(seen), ...extra });
  const items = [a("other-old", {}, 900), a("hermes", { runtime: "hermes" }), a("codex", { runtime: "codex" }), a("other-new", {}, 10),
    a("claude", { runtime: "claude" }), a("steward", { type: "steward" }), a("grok", { runtime: "grok" }), a("owner", { type: "owner" }, 5000),
    a("muse", { runtime: "muse" }), a("chatgpt", { runtime: "chatgpt" }), a("claude-code", { runtime: "claude_code" }), a("tailer", { type: "ingest-daemon" }, 1)];
  const { ctx, el } = board();
  ctx.paintAgentsBoard(el, items);
  const cards = [...el.html.matchAll(/class="agent-card" data-id="([^"]+)"/g)].map((m) => m[1]);
  expect(cards).toEqual(["owner", "steward", "claude", "claude-code", "chatgpt", "codex", "grok", "muse", "hermes", "other-new", "other-old", "tailer"]);
  expect(visibleText(el.html)).toContain("System & integration agents");
});

test("on a phone the memory state and the confirm button take their own line instead of overlapping the counts", () => {
  const css = readFileSync(new URL("../src/public/brand/dashboard.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@container (max-width:440px)"), css.indexOf("/* Switch:"));
  // flex:1 1 0 with nowrap let the nowrap "N to confirm" button draw over the session/message counts at 320 px
  // and cut "Only on request" down to its icon at 430 px.
  expect(phone).toMatch(/\.ar-status \{[^}]*flex-basis:100%[^}]*flex-wrap:wrap/);
  // A prepared save names its type in the reader's language, not the raw "note" key.
  expect(dashboardScript).toContain("noteTypeLabel(x.type || 'note')");
});
