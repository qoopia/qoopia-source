// F-313: the 5-second refresh of Overview and Agent conversations keeps the row a
// keyboard user is on: unchanged markup is not rewritten, and a rewrite re-focuses the
// same agent or conversation instead of dropping focus to <body>.
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
const threads = between("  async function fillAcThreads(cached=false) {", "  async function renderAcThread() {");

/** A list container whose rows are the focusable elements its markup declares. */
function list(doc: any) {
  const row = (attrs: string) => {
    const e: any = { dataset: {}, focus() { doc.activeElement = e; }, getAttribute: (k: string) => e.attrs[k] ?? null, attrs: {} };
    for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) { e.attrs[k!] = v; if (k!.startsWith("data-")) e.dataset[k!.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v; }
    return e;
  };
  const el: any = { writes: 0, rows: [] as any[], isConnected: true, classList: { remove() {} },
    contains: (x: unknown) => el.rows.includes(x),
    querySelectorAll: () => el.rows,
    querySelector: (s: string) => el.rows.find((r: any) => s.includes(`"${r.dataset.id}"`)) ?? null };
  Object.defineProperty(el, "innerHTML", { get: () => el.html, set: (h: string) => { el.writes++; el.html = h; el.rows = [...h.matchAll(/<(?:button|a)\b([^>]*)>/g)].map((m) => row(m[1]!)); } });
  return el;
}

function context(extra: Record<string, unknown>) {
  const doc: any = { activeElement: null };
  const ctx: any = { document: doc, window: {}, CSS: { escape: String }, setConn() {}, $: () => null,
    QI: { msg: String, relative: (n: number, u: string) => `${n} ${u}`, count: (n: number, u: string) => `${n} ${u}`, date: String, number: String, code: String, resolve: String },
    coverageLine: () => "", drillAgentById() {}, route() {}, state: {}, ...extra };
  return { ctx, doc };
}

test("Agents list: an unchanged refresh keeps focus; a reorder follows the focused agent", () => {
  const { ctx, doc } = context({});
  runInNewContext(utils + agents, ctx);
  const el = list(doc), old = "2026-01-01T00:00:00Z";
  const items = ["a", "b", "c"].map((id, i) => ({ id, name: id, type: "standard", last_seen: `2026-01-0${3 - i}T00:00:00Z` }));
  ctx.paintAgentsBoard(el, items);
  el.rows[2].focus();
  const writes = el.writes;
  ctx.paintAgentsBoard(el, items);
  expect(el.writes).toBe(writes);
  expect(el.contains(doc.activeElement)).toBe(true);
  ctx.paintAgentsBoard(el, [{ ...items[2], last_seen: "2026-01-09T00:00:00Z" }, items[0], { ...items[1], last_seen: old }]);
  expect(el.contains(doc.activeElement)).toBe(true);
  expect(doc.activeElement.dataset.id).toBe("c");
});

test("Agent conversations: the 5-second refresh keeps the focused conversation", async () => {
  const pair = (a: string, b: string, at: string) => ({ agent_a: { id: a, name: a }, agent_b: { id: b, name: b }, last_message_at: at, message_count: 1, last_message: null });
  let threads1 = [pair("x", "y", "2026-01-03T00:00:00Z"), pair("x", "z", "2026-01-02T00:00:00Z"), pair("y", "z", "2026-01-01T00:00:00Z")];
  const box: any = {};
  const { ctx, doc } = context({ api: async () => ({ items: threads1 }), $: (s: string) => (s === "#acChats" ? box.el : null), acThreads: [] });
  box.el = list(doc);
  runInNewContext(utils + "function acName(a){return (a&&(a.name||(a.id||'').slice(0,8)))||'?';}\nfunction avatarClass(){return '';}\nfunction initial(){return '';}\n" + threads, ctx);
  await ctx.fillAcThreads();
  box.el.rows[2].focus();
  await ctx.fillAcThreads();
  expect(box.el.contains(doc.activeElement)).toBe(true);
  threads1 = [threads1[2]!, threads1[0]!, threads1[1]!];
  await ctx.fillAcThreads();
  expect(box.el.contains(doc.activeElement)).toBe(true);
  expect(doc.activeElement.dataset.id).toBe("y|z");
});
