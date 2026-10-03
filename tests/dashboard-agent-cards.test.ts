// F-322: agent activity is stated in words, not by a hover-only dot.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
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
    QI: { msg: (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k])), relative: (n: number, u: string) => `${n} ${u}`, date: String, number: String, code: String, resolve: String } };
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

// F-325: Overview previews the 8 most recent agents; the Agents page lists all of them.
test("Overview shows the 8 most recent agents and links to the rest; the Agents page shows all", () => {
  const items = Array.from({ length: 41 }, (_, i) => ({ id: "w" + i, name: "worker-" + i, type: "standard", last_seen: ago(100 + i) }));
  const { ctx, el } = board();
  ctx.paintAgentsBoard(el, items, true);
  const cards = [...el.html.matchAll(/class="agent-card" data-id="([^"]+)"/g)].map((m) => m[1]);
  expect(cards).toEqual(items.slice(0, 8).map((a) => a.id));
  expect(el.html).toContain('href="#agents"');
  expect(visibleText(el.html)).toContain("+33 more agents");
  ctx.paintAgentsBoard(el, items, false);
  expect([...el.html.matchAll(/class="agent-card"/g)].length).toBe(41);
});
