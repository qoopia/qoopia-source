// F-316: on a phone the open chat covers the page, so the page behind it leaves the tab
// order (inert) while the chat is open; on a wide screen the chat stays a side panel.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/public/brand/agent-chat.js", import.meta.url), "utf8");

/** Accepts any property read, write or call the chat's mount code makes. */
function stub(): any {
  const store: Record<PropertyKey, unknown> = {};
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get: (_, k) => (k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === Symbol.toPrimitive ? () => "" : k in store ? store[k] : (store[k] = stub())),
    set: (_, k, v) => { store[k] = v; return true; },
  });
}

function page(small: boolean) {
  const app = { inert: false }, launcher = Object.assign(stub(), { hidden: true, inert: false, setAttribute() {} });
  const panel = Object.assign(stub(), { hidden: true, inert: false, querySelector: () => stub(), contains: () => false, classList: stub() });
  const media: any = { matches: small, listeners: [] as Array<() => void>, addEventListener(_: string, f: () => void) { media.listeners.push(f); }, removeEventListener() {} };
  const document = { activeElement: null, body: { children: [app, launcher, panel] }, addEventListener() {}, removeEventListener() {},
    querySelector: (s: string) => (s === "#chatPanel" ? panel : s === "#chatLauncher" ? launcher : stub()) };
  const window: any = {};
  runInNewContext(source, { window, document, matchMedia: () => media, setInterval: () => 0, clearInterval() {}, crypto: { randomUUID: () => "x" }, QI: stub() });
  const chat = window.QoopiaChat({ api: async () => ({}), esc: String, humanSize: String, onUnauthorized() {} });
  return { chat, app, launcher, panel, media };
}

test("on a phone the page behind the open chat is inert, and released on close", () => {
  const { chat, app, launcher, panel } = page(true);
  chat.open();
  expect([app.inert, launcher.inert, panel.inert]).toEqual([true, true, false]);
  launcher.onclick(); // the launcher toggles the panel closed
  expect([app.inert, launcher.inert]).toEqual([false, false]);
});

test("on a wide screen the chat stays non-modal; narrowing the window while open applies inert", () => {
  const { chat, app, media } = page(false);
  chat.open();
  expect(app.inert).toBe(false);
  media.matches = true;
  for (const f of media.listeners) f();
  expect(app.inert).toBe(true);
  chat.dispose();
  expect(app.inert).toBe(false);
});
