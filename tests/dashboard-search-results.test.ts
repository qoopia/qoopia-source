// F-326: a search result is one article with real buttons — "Open session" and the agent —
// not scrollable text and a click-only chip nested inside one big button; role labels do
// not reuse card class names. The Overview activity chip is a button too.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { dashboardScript } from "./helpers/dashboard-source.ts";

const between = (from: string, to: string) => {
  const start = dashboardScript.indexOf(from), end = dashboardScript.indexOf(to, start);
  if (start < 0 || end < 0) throw Error("dashboard marker moved: " + from);
  return dashboardScript.slice(start, end);
};
const utils = between("  function esc(s) {", "  // ---------- Navigation ----------");

function host() {
  const el: any = { dataset: {}, isConnected: true, classList: { remove() {} }, contains: () => false, querySelectorAll: () => [], querySelector: () => null };
  return el;
}
function context(extra: Record<string, unknown>) {
  return { document: {}, window: {}, CSS: { escape: String }, setConn() {}, drillAgentById() {}, route() {}, agentsCache: [], state: {}, URLSearchParams,
    QI: { msg: String, relative: (n: number, u: string) => `${n} ${u}`, date: String, number: String, code: String, resolve: String }, ...extra } as any;
}
/** Tags that carry data-aid, and every <button>…</button> body, from generated markup. */
const aidTags = (html: string) => [...html.matchAll(/<(\w+)\b[^>]*data-aid=/g)].map((m) => m[1]);
const buttonBodies = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!);

test("global search results: one article per hit, agent and Open session are separate buttons", async () => {
  const out = host();
  const ctx = context({
    $: (s: string) => (s === "#gResults" ? out : null),
    api: async () => ({ next: { messages_before: "x", notes_before: null }, items: [
      { kind: "message", id: 1, agent_id: "a1", agent_name: "alpha", session_id: "s1", role: "user", created_at: "2026-01-02T00:00:00Z", excerpt: "hello there" },
      { kind: "note", id: "n1", agent_id: "a1", agent_name: "alpha", type: "note", created_at: "2026-01-01T00:00:00Z", excerpt: "hello note" },
    ] }),
  });
  runInNewContext(utils + between("  async function doGlobalSearch(q) {", "  // ---------- Bridges"), ctx);
  await ctx.doGlobalSearch("hello");
  const html = String(out.innerHTML);
  expect([...html.matchAll(/<article\b/g)].length).toBe(2);
  expect(aidTags(html)).toEqual(["button", "button"]);
  for (const body of buttonBodies(html)) expect(body).not.toMatch(/<(button|a)\b|msg-content|data-aid/);
  expect(html).toContain("Open session");
  expect(html).not.toMatch(/class="msg-role[^"]*\bnote\b/);
  expect(html).toContain('id="gMore"');
});

test("Overview activity: the agent chip is a button", () => {
  const el = host();
  const ctx = context({ $: () => null });
  runInNewContext(utils + between("  function paintFeed(items, el) {", "  // ================= AGENTS PAGE ================="), ctx);
  ctx.paintFeed([{ action: "created", agent_id: "a1", agent_name: "alpha", summary: "did a thing", created_at: "2026-01-01T00:00:00Z" }], el);
  expect(aidTags(String(el.innerHTML))).toEqual(["button"]);
});
