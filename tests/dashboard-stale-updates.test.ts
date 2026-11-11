// 5.0.25: answers and 5-second refreshes that arrive late must not overwrite what the owner is looking at,
// typing into or has just clicked. Each test runs the page's own function, cut out of the script, on stubs.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { dashboardScript } from "./helpers/dashboard-source.ts";

const between = (from: string, to: string) => {
  const start = dashboardScript.indexOf(from), end = dashboardScript.indexOf(to, start);
  if (start < 0 || end < 0) throw Error("dashboard marker moved: " + from);
  return dashboardScript.slice(start, end);
};
const esc = between("  function esc(s) {", "  function fmtTime(");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const msg = (source: string, params?: Record<string, unknown>) => source.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ""));

test("agent search: a slow answer to an older query does not land under a newer one", async () => {
  const input: any = { value: "", addEventListener(_: string, fn: () => void) { input.typed = fn; } };
  const results: any = { dataset: {}, isConnected: true, innerHTML: "", querySelectorAll: () => [] };
  const answers: Record<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }> = {};
  runInNewContext(esc + between("  async function renderAgentSearch() {", "  async function renderSession() {") + "\nvoid renderAgentSearch()", {
    $: (s: string) => (s === "#searchInp" ? input : s === "#searchResults" ? results : {}), state: { drill: { agent: { id: "a1" }, searchQuery: "" } },
    QI: { msg, code: String }, focusField() {}, setConn() {}, roleIcon: () => "", fmtTimeFull: String, copyText() {}, openDrill() {},
    errBox: (el: any, what: string) => { el.innerHTML = "ERR " + what; }, setTimeout: (fn: () => void) => { fn(); return 0; }, clearTimeout() {},
    api: (url: string) => new Promise((resolve, reject) => { answers[decodeURIComponent(/q=([^&]*)/.exec(url)![1]!)] = { resolve, reject }; }),
  });
  const type = (q: string) => { input.value = q; input.typed(); };
  const hit = (content: string) => ({ items: [{ role: "user", session_id: "s1", created_at: "", content }] });
  type("old"); type("new");
  answers.new!.resolve(hit("answer for new")); await tick();
  answers.old!.resolve(hit("answer for old")); await tick();
  expect(results.innerHTML).toContain("answer for new");
  expect(results.innerHTML).not.toContain("answer for old");
  // A late failure of the older query does not replace the newer answer either.
  type("first"); type("second");
  answers.second!.resolve(hit("answer for second")); await tick();
  answers.first!.reject(Object.assign(new Error("slow"), { status: 502 })); await tick();
  expect(results.innerHTML).toContain("answer for second");
  // Clearing the field while a query is in flight leaves the prompt, not that query's answer.
  type("gone"); type("");
  answers.gone!.resolve(hit("answer for gone")); await tick();
  expect(results.innerHTML).toContain("Type to search…");
});

test("memory saves: the result of the last decision is still on the page after its block is removed", async () => {
  const cards: any[] = [], result = { textContent: "" }, feedback = { textContent: "" }, title = { textContent: "" };
  const host: any = { removed: false, remove() { host.removed = true; }, querySelector: () => title,
    querySelectorAll: (s: string) => (s === "button" ? cards.flatMap((c) => c.buttons) : cards),
    insertAdjacentHTML(_: string, html: string) {
      for (const [, id] of html.matchAll(/data-save="([^"]+)"/g)) {
        const card: any = { dataset: { save: id }, querySelectorAll: () => card.buttons, remove() { cards.splice(cards.indexOf(card), 1); } };
        card.buttons = ["1", ""].map((accept) => ({ dataset: accept ? { accept } : {}, disabled: false, closest: () => card }));
        cards.push(card);
      }
    } };
  const agent = { id: "a1", memory: { pending_saves: 2 } };
  const save = (id: string) => ({ id, agent_id: "a1", operation: "note_create", type: "note", text: "synthetic", expires_at_ms: 1_800_000_000_000 });
  await runInNewContext(esc + between("  async function bindMemorySaves(a) {", "  // Only 403 means") + "\nbindMemorySaves(agent)", {
    agent, $: (s: string) => (s === "#memorySaves" ? host : s === "#memoryResult" ? (host.removed ? null : result) : s === "#uiFeedback" ? feedback : null),
    QI: { msg, resolve: String }, api: async () => ({ items: [save("s1"), save("s2")] }), apiWrite: async () => ({}),
    noteTypeLabel: String, fmtTimeFull: String, fmtNum: String, errBox() {}, memoryWriteFailed() {},
  });
  await cards[0].buttons[0].onclick();
  expect([host.removed, result.textContent, agent.memory.pending_saves]).toEqual([false, "Saved to memory.", 1]);
  await cards[0].buttons[1].onclick();
  expect(host.removed).toBe(true);
  expect(feedback.textContent).toBe("Declined. The prepared text was removed.");
});

/** The Memory page on stubs: writing main.innerHTML replaces every element, as the browser does. */
function memoryPage(data: any, apiWrite: () => Promise<unknown>) {
  let nodes: Record<string, any> = {}, next = data;
  const node = (): any => ({ style: {}, dataset: {}, textContent: "", value: "", disabled: false, after() {}, append() {}, setAttribute() {} });
  const $ = (s: string) => (nodes[s] ??= Object.assign(node(), { id: s.slice(1) }));
  const page: any = { writes: 0, $, focused: { tagName: "BUTTON" }, answer(value: unknown) { next = value; } };
  const main = { set innerHTML(_: string) { page.writes++; nodes = {}; },
    get firstElementChild() { return { isConnected: true, querySelectorAll: () => ["memorySelect", "memoryLogin", "memoryCheck", "memoryConnections", "memorySessions"].map((id) => $("#" + id)) }; } };
  page.ctx = { main, $, data, state: { page: "work" }, QI: { msg }, document: { createElement: node, get activeElement() { return page.focused; } },
    sessionStorage: { getItem: () => null, setItem() {} }, setCrumb() {}, go() {}, errBox() {}, fmtTimeFull: String, api: async () => next, apiWrite };
  page.open = () => runInNewContext(esc + between("  async function renderWorkspace(snapshot) {", "\n  const SURFACE_NAMES=") + "\nrenderWorkspace(data)", page.ctx);
  return page;
}
const memory = (extra: Record<string, unknown> = {}) => ({ model: { state: "selected", runtime: "claude_code" }, embedding: { embedded: 1, total_notes: 2 },
  sessions: { summarized: 0, tracked: 0 }, operation: null, busy: false, login: { state: "waiting", url: "https://claude.example/sign-in" }, ...extra });

test("Memory: the 5-second refresh does not wipe a Claude sign-in code that is typed but not yet sent", async () => {
  const page = memoryPage(memory(), async () => ({}));
  await page.open();
  expect(page.writes).toBe(1);
  // The owner pasted the code and moved to the «Complete sign-in» button; meanwhile the indexed-notes count changed.
  page.$("#memoryLoginCode").value = "pasted-code";
  page.answer(memory({ embedding: { embedded: 2, total_notes: 2 } }));
  await page.ctx.pollFn();
  expect([page.writes, page.$("#memoryLoginCode").value]).toEqual([1, "pasted-code"]);
  // With the field empty the page refreshes as before.
  page.$("#memoryLoginCode").value = "";
  await page.ctx.pollFn();
  expect(page.writes).toBe(2);
});

const patch = between("  function patch(el, html) {", "  // ---------- Errors ----------");
/** Accepts any property read, write or call: the parts of a page a test does not look at. */
function anything(): any {
  const store: Record<PropertyKey, unknown> = {};
  return new Proxy(function () { return anything(); }, {
    get: (_, k) => (k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : k in store ? store[k] : (store[k] = anything())),
    set: (_, k, v) => { store[k] = v; return true; },
  });
}
/** An element that counts how often its content is rewritten. */
const counted = (): any => ({ writes: 0, value: "", dataset: {}, contains: () => false, querySelectorAll: () => [], querySelector: () => null, setAttribute() {},
  set innerHTML(html: string) { this.writes++; this.html_ = html; }, get innerHTML() { return this.html_; }, insertAdjacentHTML(_: string, html: string) { this.writes++; this.html_ += html; } });

test("Bridges: an unchanged 5-second refresh leaves the bridge select and the lists as they are", async () => {
  const select = counted(), list = counted(), connection = counted();
  const tabs = ["outgoing", "received", "catalogues", "requests", "members"].map((section) => ({ dataset: { section }, hidden: false, setAttribute() {} }));
  const root = { isConnected: true, querySelector: () => anything(), querySelectorAll: (s: string) => (s === "[data-section]" ? tabs : []) };
  const fixed: Record<string, unknown> = { "#bridgeRoot": root, "#bridgeDialog": { open: false, showModal() {}, close() {} }, "#bridgeGroup": select, "#bridgeList": list,
    "#bridgeConnection": connection, "#bridgeSearch": { value: "" }, "#bridgeWithdraw": null };
  const others: Record<string, unknown> = {};
  let data: any = { groups: [{ id: "g1", name: "Circle", state: "active", creator: true, online: true, members: [{ peer: "p1", name: "Me", state: "active" }, { peer: "p2", name: "Ann", state: "active" }] }],
    agents: [], agent_id: null, recent_sources: [], pending_controls: [], materials: [], publications: [], catalogues: [], requests: [], peer_id: "p1", limits: { file_bytes: 1 },
    invitations: [{ id: "i1", group_id: "g1", revoked: 0, expires_at_ms: Date.now() + 3_600_000 }] };
  const ctx: any = { main: {}, $: (s: string) => (s in fixed ? fixed[s] : (others[s] ??= anything())), setCrumb() {}, crypto: { randomUUID: () => "id" }, CSS: { escape: String },
    document: { activeElement: null, createElement: anything }, QI: { msg, count: (n: number, unit: string) => n + " " + unit, code: String, date: String }, api: async () => data };
  await runInNewContext(patch + esc + between("  async function renderBridgesPage(folderOnly=false) {", "  // ---------- Memory ----------") + "\nrenderBridgesPage()", ctx);
  expect(list.innerHTML).toContain("Ann");
  expect(list.innerHTML).toContain("Revoke invitation");
  const first = [select.writes, list.writes, connection.writes];
  await ctx.pollFn(); await ctx.pollFn();
  expect([select.writes, list.writes, connection.writes]).toEqual(first);
  expect(select.value).toBe("g1");
  // What did change is redrawn, and only that.
  data = { ...data, groups: [{ ...data.groups[0], online: false }] };
  await ctx.pollFn();
  expect([select.writes, list.writes, connection.writes]).toEqual([first[0]!, first[1]!, first[2]! + 1]);
});

/** The Connections page on stubs; `refresh` is what the 5-second poll of the page calls. */
async function connectionsPage(apiWrite: () => Promise<unknown>) {
  const list = counted(), status = { textContent: "" }, nodes: Record<string, unknown> = {};
  const app = (id: string, name: string) => ({ kind: "oauth", id, name, client: "Claude", surface: "claude_web", state: "verified", authorized: true, last_seen: new Date().toISOString(), created_at: new Date().toISOString() });
  const page: any = { list, status, data: { workspace: "Home", workspace_id: "w1", stewards: [], apps: [app("a1", "Atlas")], memory_model: null, installed: false }, app, confirms: 0 };
  const ctx = { main: { querySelectorAll: () => [] }, $: (s: string) => (s === "#connectedApplications" ? list : s === "#connectionsStatus" ? status : (nodes[s] ??= anything())),
    state: { page: "connections" }, setCrumb() {}, errBox() {}, go() {}, SURFACE_NAMES: {}, CSS: { escape: String }, document: { activeElement: null },
    QI: { msg, resolve: String, date: String }, window: { confirm: () => { page.confirms++; return true; } }, api: async () => page.data, apiWrite,
    renderHeadlessServicePairing() {}, renderConnectionWizard: async (_h: unknown, _n: unknown, _i: unknown, refresh: () => Promise<void>) => { page.refresh = refresh; } };
  await runInNewContext(patch + esc + between("  async function renderConnections() {", "  // Who is looking:") + "\nrenderConnections()", ctx);
  /** A click on the row's button as the page has it now (a redraw makes a new, enabled button). */
  page.click = () => { const button = { dataset: { disconnect: "oauth:a1", name: "Claude · Atlas" }, disabled: false }; return { button, done: list.onclick({ target: { closest: () => button } }) }; };
  return page;
}

test("Connections: an unchanged refresh does not rewrite the applications, so focus and a pressed button stay", async () => {
  const page = await connectionsPage(async () => ({}));
  expect(page.list.innerHTML).toContain("Atlas");
  const writes = page.list.writes;
  await page.refresh(); await page.refresh();
  expect(page.list.writes).toBe(writes);
  page.data = { ...page.data, apps: [...page.data.apps, page.app("a2", "Vega")] };
  await page.refresh();
  expect(page.list.writes).toBe(writes + 1);
  expect(page.list.innerHTML).toContain("Vega");
});

test("Connections: «Disconnect» is sent once even when a refresh redraws the row during the request", async () => {
  let sent = 0, finish: (v: unknown) => void = () => {};
  const page = await connectionsPage(() => { sent++; return new Promise((resolve) => { finish = resolve; }); });
  const first = page.click();
  // Another application connects meanwhile: the list is redrawn with a fresh, enabled «Disconnect» for the same row.
  page.data = { ...page.data, apps: [...page.data.apps, page.app("a2", "Vega")] };
  await page.refresh();
  void page.click(); await tick();
  expect([sent, page.confirms]).toEqual([1, 1]);
  finish({}); await first.done;
  expect(page.status.textContent).toBe("Disconnected: Claude · Atlas");
  // After the answer the row can be used again.
  void page.click(); await tick();
  expect(sent).toBe(2);
});

test("Memory: a failed action gives back only the buttons that were available before it", async () => {
  // No subscription chosen yet: «Sign in» and «Check connection» are unavailable, «Use this subscription» is.
  const page = memoryPage(memory({ model: { state: "not_connected", runtime: null }, login: null }), async () => { throw new Error("The server could not complete the request."); });
  await page.open();
  expect([page.$("#memorySelect").disabled, page.$("#memoryLogin").disabled, page.$("#memoryCheck").disabled]).toEqual([false, true, true]);
  await page.$("#memorySelect").onclick();
  expect(page.$("#memoryActionStatus").textContent).toBe("The server could not complete the request.");
  expect([page.$("#memorySelect").disabled, page.$("#memoryLogin").disabled, page.$("#memoryCheck").disabled]).toEqual([false, true, true]);
});

test("Files: a folder that failed to load does not put its error over the folder opened after it", async () => {
  const list: any = { isConnected: true, innerHTML: "", className: "", querySelectorAll: () => [] };
  const answers: Record<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }> = {};
  const ctx: any = { $: (s: string) => (s === "#fList" ? list : null), QI: { msg, count: String }, lineIcon: () => "", humanSize: String, fmtTime: String, BASE: "", setConn() {},
    errBox: (el: any, what: string) => { el.innerHTML = "ERR " + what; }, filesDelete() {},
    api: (url: string) => new Promise((resolve, reject) => { answers[decodeURIComponent(url.split("folder=")[1] ?? "")] = { resolve, reject }; }) };
  runInNewContext("let filesPath='slow',filesFolders=[],filesNew=[];function openFolder(path){filesPath=path;return filesLoadList();}\n" + esc +
    between("  async function filesLoadList() {", "  // A refused batch stores nothing"), ctx);
  const slow = ctx.filesLoadList(), next = ctx.openFolder("reports");
  answers.reports!.resolve({ files: [{ id: "f1", filename: "summary.csv", folder: "reports", size: 1, created_at: "" }] }); await next;
  answers.slow!.reject(Object.assign(new Error("slow"), { status: 502 })); await slow;
  expect(list.innerHTML).toContain("summary.csv");
  // The folder on screen still reports its own failure.
  const again = ctx.openFolder("reports");
  answers.reports!.reject(Object.assign(new Error("down"), { status: 502 })); await again;
  expect(list.innerHTML).toBe("ERR Failed to load files.");
});

test("Files: a failed upload says so in words, not «Could not load (500) — internal»", () => {
  const progress = { textContent: "" }, requests: any[] = [];
  class XMLHttpRequest { upload = {}; status = 0; responseText = ""; onload = () => {}; open() {} setRequestHeader() {} send() { requests.push(this); } }
  const ctx: any = { $: (s: string) => (s === "#fProg" ? progress : null), QI: { msg, count: String }, BASE: "", XMLHttpRequest, FormData: class { append() {} }, showLogin() {} };
  runInNewContext("let filesPath='',filesNew=[];\n" + between("  function errReason(e) {", "  function errBox(") + between("  function uploadRefusal(j) {", "  async function filesDelete(id) {"), ctx);
  const fail = (status: number, body: string) => { ctx.filesUpload([{ name: "notes.txt", size: 5 }]); const request = requests.at(-1); request.status = status; request.responseText = body; request.onload(); return progress.textContent; };
  expect(fail(500, '{"error":"internal"}')).toBe("Upload error. The server could not complete the request.");
  expect(fail(502, "<html>Bad gateway</html>")).toBe("Upload error. The server could not complete the request.");
  // A sentence the server wrote for this refusal is kept.
  expect(fail(400, '{"error":"invalid_input","detail":"A file with this name is being written."}')).toBe("Upload error. A file with this name is being written.");
  expect(fail(400, '{"error":"invalid_input","reason":"empty_file","file":"notes.txt"}')).toBe("Nothing was uploaded: notes.txt is empty.");
});

test("Canon: «Retire» asks first and says when the rule is retired", async () => {
  const result = { textContent: "" }, sent: string[] = [];
  let agreed = false, items = [{ id: "c1", text: "Отвечай коротко.", scope: "workspace", mode: "always" }];
  const el: any = { isConnected: true, html: "", set innerHTML(html: string) { this.html = html; this.buttons = [...html.matchAll(/data-retire="([^"]+)"/g)].map(([, retire]) => ({ dataset: { retire }, disabled: false })); },
    get innerHTML() { return this.html; }, querySelectorAll: () => el.buttons };
  const ctx: any = { el, $: (s: string) => (s === "#canonResult" ? result : null), state: { drill: null, page: "canon" }, localWorkspace: true, QI: { msg, resolve: String }, setConn() {}, errBox() {},
    fmtNum: String, fmtTime: String, window: { confirm: () => agreed }, api: async () => ({ items }),
    apiWrite: async (url: string) => { sent.push(url); items = []; return {}; } };
  await runInNewContext(esc + between("  const canonScope", "  function renderCanonPage() {") + "\nrenderCanonList(el, null)", ctx);
  await el.buttons[0].onclick();
  expect(sent).toEqual([]);
  expect(el.buttons[0].disabled).toBe(false);
  agreed = true;
  await el.buttons[0].onclick();
  expect(sent).toEqual(["/api/dashboard/canons/c1/retire"]);
  expect(el.buttons).toEqual([]);
  expect(result.textContent).toBe("Canon retired");
});

test("Skills: «Save draft» pressed twice sends one request", async () => {
  let calls = 0, finish: (v: unknown) => void = () => {};
  const save = { disabled: false }, form: any = { querySelector: () => save }, nodes: Record<string, unknown> = { "#skillForm": form };
  runInNewContext(esc + between("  function skillEditor(existing, fork=false) {", "  async function skillDetail(id) {") + "\nskillEditor()", {
    $: (s: string) => (nodes[s] ??= anything()), QI: { msg, resolve: String }, skillShell() {}, skillStatus() {}, skillFailure() {}, skillDetail: async () => {}, renderSkillsPage() {},
    skillApi: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const submit = () => form.onsubmit({ preventDefault() {} });
  const first = submit(); void submit(); await tick();
  expect([calls, save.disabled]).toEqual([1, true]);
  finish({ data: { outcome: "refused", reason: "" } }); await first;
  expect(save.disabled).toBe(false);
});
