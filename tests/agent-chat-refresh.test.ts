// 5.0.25: the chat panel re-reads its state every 1.5 s. A refresh must not rebuild what did not change
// (the Telegram link lost focus and clicks) nor empty an answer the owner is typing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/public/brand/agent-chat.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Accepts any property read, write or call the chat's code makes on parts a test does not look at. */
function anything(): any {
  const store: Record<PropertyKey, unknown> = {};
  return new Proxy(function () { return anything(); }, {
    get: (_, k) => (k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : k in store ? store[k] : (store[k] = anything())),
    set: (_, k, v) => { store[k] = v; return true; },
  });
}

/** The open chat on stubs. UI text is a token until the page shows it, as with the real locale runtime. */
async function chat(data: any) {
  const shown = (html: string) => html.replace(/[]/g, "");
  const document: any = { activeElement: null, hidden: false, body: { children: [] }, addEventListener() {} };
  // What the browser holds differs from what was assigned: the runtime has replaced the tokens with words.
  const link: any = { writes: 0, dataset: {}, set innerHTML(html: string) { this.writes++; this.html = shown(html); }, get innerHTML() { return this.html ?? ""; } };
  const approvals: any = { inputs: [] as any[], dataset: {}, contains: (x: unknown) => approvals.inputs.includes(x),
    querySelectorAll: (s: string) => (s === "[data-question]" ? approvals.inputs : []),
    set innerHTML(html: string) {
      approvals.inputs = html.split("<section").slice(1).flatMap((part) => {
        const section = { dataset: { request: /data-request="([^"]*)"/.exec(part)?.[1] } };
        return [...part.matchAll(/data-question="([^"]*)"/g)].map(([, question]) => {
          const input: any = { dataset: { question }, value: "", closest: () => section, focus() { document.activeElement = input; } };
          return input;
        });
      });
    } };
  const feedback = { textContent: "" }, root = { isConnected: true, dataset: {}, setAttribute() {}, removeAttribute() {} };
  const fixed: Record<string, unknown> = { "#telegramLink": link, "#agentApprovals": approvals, "#agentFeedback": feedback, "#myAgent": root };
  const others: Record<string, unknown> = {};
  const panel = Object.assign(anything(), { hidden: true, contains: () => false, querySelector: (s: string) => (s in fixed ? fixed[s] : (others[s] ??= anything())) });
  let poll = () => {};
  const window: any = {};
  runInNewContext(source, { window, document, matchMedia: () => ({ matches: false, addEventListener() {} }), setInterval: (fn: () => void) => { poll = fn; return 0; }, clearInterval() {},
    crypto: { randomUUID: () => "id" }, AbortSignal, Date, QI: { msg: (s: string) => "" + s + "", resolve: shown } });
  document.querySelector = (s: string) => (s === "#chatPanel" ? panel : anything());
  const state = { data };
  window.QoopiaChat({ api: async () => state.data, send: async () => ({}), esc: String, humanSize: String, onUnauthorized() {} }).open();
  await tick();
  return { link, approvals, feedback, state, document, refresh: async () => { poll(); await tick(); } };
}
const agent = (extra: Record<string, unknown> = {}) => ({ configured: true, running: true, account: true, provider: "codex", operation: null, conversations: [], runs: [], approvals: [],
  selected: null, active_conversation: null, telegram: { username: "synthetic_bot", linked: true, verified: true }, telegram_setup: null, ...extra });

test("the Telegram link is built once, not on every 1.5-second refresh", async () => {
  const page = await chat(agent());
  expect(page.feedback.textContent).toBe("");
  expect(page.link.innerHTML).toContain("https://t.me/synthetic_bot");
  expect(page.link.writes).toBe(1);
  await page.refresh(); await page.refresh();
  expect(page.link.writes).toBe(1);
  // A real change is still shown.
  page.state.data = agent({ telegram: { username: "another_bot", linked: true, verified: true } });
  await page.refresh();
  expect(page.link.writes).toBe(2);
  expect(page.link.innerHTML).toContain("https://t.me/another_bot");
});

test("a second request from the agent does not empty the answer being typed for the first", async () => {
  const ask = (id: string) => ({ id, method: "item/tool/requestUserInput", params: { reason: "Synthetic question", questions: [{ id: "q1", question: "Which folder?" }] } });
  const page = await chat(agent({ active_conversation: "c1", approvals: [ask("first")] }));
  expect(page.feedback.textContent).toBe("");
  const typing = page.approvals.inputs[0];
  typing.value = "the reports folder"; typing.focus();
  page.state.data = agent({ active_conversation: "c1", approvals: [ask("first"), ask("second")] });
  await page.refresh();
  expect(page.approvals.inputs.map((input: any) => input.value)).toEqual(["the reports folder", ""]);
  expect(page.document.activeElement).toBe(page.approvals.inputs[0]);
  // Each request keeps its own answer, also when the one before it is gone.
  page.approvals.inputs[1].value = "for the second";
  page.state.data = agent({ active_conversation: "c1", approvals: [ask("second")] });
  await page.refresh();
  expect(page.approvals.inputs.map((input: any) => input.value)).toEqual(["for the second"]);
});
