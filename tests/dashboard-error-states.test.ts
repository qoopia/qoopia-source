// F-323 / F-311: every failed dashboard load says what failed in words and offers
// Retry; raw codes (HTTP_500, too_many_requests, Failed to fetch) stay off the page,
// and only a network failure turns the connection badge to Offline.
// A9: the server's half of it. A list that could not be read answers with an error status, so the
// page shows that failure instead of an empty list that looks like "nothing here".
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { runInNewContext } from "node:vm";
import net, { type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { dashboardScript } from "./helpers/dashboard-source.ts";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { logger } from "../src/utils/logger.ts";
import { REQUEST_TIMEOUTS } from "../src/utils/http-json.ts";
import * as canonProposals from "../src/services/canon-proposals.ts";
import * as saveRequests from "../src/services/memory-save-requests.ts";

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
  saves: between("  // The agent prepared these notes", "  // Only 403 means \"not the owner\"."),
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
  if (view === "files") { ctx.filesPath = "inbox"; ctx.filesFolders = []; ctx.filesNew = []; $("#fList"); await ctx.filesLoadList(); }
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
      expect(html).toMatch(/class="[^"]*\berr\b/);
      expect(html).toContain(words);
      expect(html).toContain(">Retry</button>");
      expect(html).not.toMatch(/HTTP_|too_many|Failed to fetch/);
      expect(typeof retry).toBe("function");
      expect(conn).toEqual(offline ? [false] : []);
    }
  });
}

test("api() keeps the HTTP status and Retry-After for the error text", async () => {
  const ctx: any = { BASE: "", AbortSignal, showLogin() {}, Number, QI: { msg: String, resolve: String }, errReason: (e: any) => "Too many requests. Try again in " + e.retryAfter + " s.",
    fetch: async () => ({ status: 429, ok: false, headers: new Headers({ "retry-after": "41" }), json: async () => ({ error: "too_many_requests" }) }) };
  runInNewContext(between("  // ---------- API ----------", "  async function apiWrite(path, body) {"), ctx);
  const error = await ctx.api("/x").catch((e: unknown) => e);
  expect(error.status).toBe(429);
  expect(error.retryAfter).toBe(41);
  expect(error.message).toBe("Too many requests. Try again in 41 s.");
});

let server: Server, base = "", STEWARD = "";
beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Error states", slug: "a9-error-states" });
  STEWARD = createAgent({ name: "a9-steward", workspaceSlug: ws.slug, type: "steward" }).api_key;
  server = startHttpServer();
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); });
const get = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${STEWARD}` } });
/** Statements whose SQL contains the fragment fail like a broken database; everything else runs. */
function breakSql(fragment: string) {
  const prepare = db.prepare.bind(db);
  return spyOn(db, "prepare").mockImplementation(((sql: string, ...rest: unknown[]) => {
    if (sql.includes(fragment)) throw new Error("disk I/O error");
    return (prepare as (...args: unknown[]) => unknown)(sql, ...rest);
  }) as typeof db.prepare);
}

test("A9: a list query that fails answers 500, not 200 with an empty list", async () => {
  const errors = spyOn(logger, "error").mockImplementation(() => {});
  try {
    for (const [path, fragment] of [["/api/dashboard/activity", "FROM activity a"], ["/api/dashboard/skills", "FROM entity_pages"]] as const) {
      expect([path, (await get(path)).status]).toEqual([path, 200]);
      const broken = breakSql(fragment);
      try {
        const r = await get(path);
        expect([path, r.status, await r.json()]).toEqual([path, 500, { error: "query_failed" }]);
      } finally { broken.mockRestore(); }
    }
    // The overview keeps its other tiles when one count fails, and the failure now reaches the log.
    errors.mockClear();
    const broken = breakSql("FROM bridges");
    try {
      const r = await get("/api/dashboard/overview");
      expect(r.status).toBe(200);
      expect(((await r.json()) as { bridges: unknown }).bridges).toBeNull();
      expect(errors.mock.calls).toContainEqual(["dashboard query failed", { error: "disk I/O error" }]);
    } finally { broken.mockRestore(); }
  } finally { errors.mockRestore(); }
});

test("A9: an owner-only list answers 403 only to someone who is not the owner; a failure is 500", async () => {
  const errors = spyOn(logger, "error").mockImplementation(() => {});
  try {
    const fail = () => { throw new Error("disk I/O error"); };
    for (const [path, breakList] of [["/api/dashboard/canon-proposals", () => spyOn(canonProposals, "listCanonProposals").mockImplementation(fail)],
      ["/api/dashboard/memory-saves", () => spyOn(saveRequests, "listSaveRequests").mockImplementation(fail)]] as const) {
      expect([path, (await get(path)).status]).toEqual([path, 403]);
      const broken = breakList();
      try {
        const r = await get(path);
        expect([path, r.status, await r.json()]).toEqual([path, 500, { error: "query_failed" }]);
      } finally { broken.mockRestore(); }
    }
    expect(errors.mock.calls.filter((call) => call[0] === "dashboard list failed")).toHaveLength(2);
  } finally { errors.mockRestore(); }
});

test("A9: a malformed escape in a canon address is the caller's mistake (400), not a server failure", async () => {
  expect((await get("/api/dashboard/canons/%E0%A4%A")).status).toBe(400);
  expect((await get("/api/dashboard/canons/no-such-canon")).status).toBe(404);
});

test("A9: a wake reply whose body stalls is a timeout (408), not \"too large\" (413)", async () => {
  const saved = REQUEST_TIMEOUTS.bodyBaseMs;
  REQUEST_TIMEOUTS.bodyBaseMs = 300;
  try {
    const line = await new Promise<string>((resolve) => {
      const socket = net.connect(Number(new URL(base).port), "127.0.0.1", () => socket.write("POST /api/v1/agentcomm/wake-reply HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nab"));
      let got = "";
      socket.on("data", (chunk) => (got += chunk));
      const done = () => { socket.destroy(); resolve(got.split("\r\n")[0]!); };
      socket.on("close", done); socket.on("error", done);
      setTimeout(done, 3000);
    });
    expect(line).toBe("HTTP/1.1 408 Request Timeout");
    const big = await fetch(`${base}/api/v1/agentcomm/wake-reply`, { method: "POST", body: "a".repeat(2_000_000) });
    expect([big.status, ((await big.json()) as { error: string }).error]).toEqual([413, "payload_too_large"]);
  } finally { REQUEST_TIMEOUTS.bodyBaseMs = saved; }
});
