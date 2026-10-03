// F-323 / F-311: every failed dashboard load says what failed in words and offers
// Retry; raw codes (HTTP_500, too_many_requests, Failed to fetch) stay off the page,
// and only a network failure turns the connection badge to Offline.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { dashboardScript } from "./helpers/dashboard-source.ts";

const between = (from: string, to: string) => {
  const start = dashboardScript.indexOf(from), end = dashboardScript.indexOf(to, start);
  if (start < 0 || end < 0) throw Error("dashboard marker moved: " + from);
  return dashboardScript.slice(start, end);
};
const errors = dashboardScript.includes("  // ---------- Errors ----------") ? between("  // ---------- Errors ----------", "  // ---------- Navigation ----------") : "";
const views = {
  agents: between("  async function renderAgentsPage() {", "  function drillAgentById(id) {"),
  conversations: between("  async function fillAcThreads(cached=false) {", "  async function renderAcThread() {"),
  files: between("  async function filesLoadList() {", "  function filesUpload(fileList) {"),
  saves: between("  // The agent prepared these notes", "  function bindMemoryPanel(a) {"),
};

function node(): any {
  const button: any = {};
  const el: any = {
    className: "loading", innerHTML: "", isConnected: true, children: [] as any[], button,
    classList: { remove: (...names: string[]) => { el.className = el.className.split(" ").filter((c: string) => !names.includes(c)).join(" "); } },
    querySelector: (s: string) => (s === "button" ? button : null), querySelectorAll: () => [],
    insertAdjacentHTML: (_: string, html: string) => { const child = node(); child.className = ""; child.outer = html; child.remove = () => {}; el.children.push(child); el.lastElementChild = child; },
  };
  return el;
}

async function fail(view: keyof typeof views, error: Error) {
  const elements: Record<string, any> = {};
  const $ = (s: string) => (elements[s] ??= node());
  const conn: boolean[] = [];
  const ctx: any = {
    $, QI: { msg: (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k])) }, esc: String,
    setConn: (ok: boolean) => conn.push(ok), api: async () => { throw error; }, main: node(), setCrumb() {}, isInfra: () => false,
    byRecent: () => 0, agentCard: () => "", acName: String, avatarClass: String, initial: String, fmtTime: String, fmtNum: String,
    fmtTimeFull: String, state: {}, route() {}, drillAgentById() {}, agentsCache: null, acThreads: [],
  };
  runInNewContext(errors + views[view], ctx);
  if (view === "agents") await ctx.renderAgentsPage();
  if (view === "conversations") { $("#acChats"); await ctx.fillAcThreads(); }
  if (view === "files") { $("#fFolder").value = "inbox"; $("#fList"); await ctx.filesLoadList(); }
  if (view === "saves") { $("#memorySaves"); await ctx.bindMemorySaves({ id: "a1" }); }
  const host = { agents: "#agentsWrap", conversations: "#acChats", files: "#fList", saves: "#memorySaves" }[view];
  const box = view === "saves" ? elements[host]!.lastElementChild : elements[host];
  return { html: String(box?.innerHTML ?? ""), retry: box?.button?.onclick, conn };
}

const http = (status: number, message: string) => Object.assign(new Error(message), { status, retryAfter: status === 429 ? 41 : 0 });

for (const view of Object.keys(views) as Array<keyof typeof views>) {
  test(`${view}: a failure is explained in words with Retry`, async () => {
    for (const [error, words, offline] of [
      [http(500, "HTTP_500: Request failed"), "The server could not complete the request.", false],
      [http(429, "too_many_requests"), "Too many requests. Try again in 41 s.", false],
      [new TypeError("Failed to fetch"), "Could not reach the server. Check your connection.", true],
    ] as const) {
      const { html, retry, conn } = await fail(view, error);
      expect(html).toContain('class="err"');
      expect(html).toContain(words);
      expect(html).toContain(">Retry</button>");
      expect(html).not.toMatch(/HTTP_|too_many|Failed to fetch/);
      expect(typeof retry).toBe("function");
      expect(conn).toEqual(offline ? [false] : []);
    }
  });
}

test("api() keeps the HTTP status and Retry-After for the error text", async () => {
  const ctx: any = { BASE: "", AbortSignal, showLogin() {}, Number,
    fetch: async () => ({ status: 429, ok: false, headers: new Headers({ "retry-after": "41" }), json: async () => ({ error: "too_many_requests" }) }) };
  runInNewContext(between("  async function api(path) {", "  async function apiWrite(path, body) {"), ctx);
  const error = await ctx.api("/x").catch((e: unknown) => e);
  expect(error.status).toBe(429);
  expect(error.retryAfter).toBe(41);
});
