// A4-21: every new date, count or parameter set made a token the runtime kept forever; a dashboard left open
// with 5-second polling grew without bound. Old unused tokens are now dropped; plain messages stay.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const runtime = readFileSync(new URL("../src/public/brand/i18n.js", import.meta.url), "utf8");
function load() {
  const window: any = { addEventListener() {}, dispatchEvent() {} };
  runInNewContext(runtime, { window, document: { cookie: "", documentElement: {}, addEventListener() {} }, location: { search: "?lang=ru", hostname: "x" },
    localStorage: { getItem: () => null }, navigator: { language: "ru" }, crypto: globalThis.crypto, Intl, URLSearchParams, RegExp, Map, Set, JSON, Number, String, Array, Date, CustomEvent: class {} });
  return window.QI;
}

test("tokens stay bounded; a plain message and the newest tokens still resolve", () => {
  const QI = load(), plain = QI.msg("Agents");
  const first = QI.count(1, "message");
  let last = "";
  for (let i = 0; i < 50_000; i++) last = QI.date(i * 1000, { timeStyle: "short" });
  expect(QI.resolve(plain)).toBe("Агенты");
  expect(QI.resolve(last)).not.toBe("");
  expect(QI.resolve(first)).toBe(""); // old and unused: dropped
  // A dropped value asked again gets a fresh token that resolves.
  expect(QI.resolve(QI.count(1, "message"))).toBe("1 сообщение");
});
