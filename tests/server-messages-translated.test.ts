// A4-03: the dashboard shows the server's error sentences through the catalog (failure() → QI.msg).
// Every sentence these routes and services can send to the page must have a Russian translation.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ru: Record<string, string> = JSON.parse(readFileSync(new URL("../src/public/brand/i18n.ru.json", import.meta.url), "utf8"));
const FILES = ["src/http.ts", "src/dashboard-api.ts", "src/services/my-agent.ts", "src/bridges/api.ts", "src/bridges/service.ts",
  // next_action hints of the Memory and Connections pages
  "src/services/browser-connections.ts", "src/services/client-connections.ts", "src/services/memory-setup.ts",
  "src/delivery/managed-transport.ts", "src/delivery/client-config.ts", "src/delivery/desktop-auth.ts", "src/delivery/memory-client.ts"];
const PATTERNS = [
  /new QoopiaError\(\s*['"][A-Z_]+['"]\s*,\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g,
  /\b(?:error_description|next_action)\s*:\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g,
  /\.error\s*=\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g,
  /(?:finish|stopFinished)\(session,\s*'[a-z]+'\s*,\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g,
  /:\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1\s*\)\s*;?\s*if\(live/g,
];

export function serverSentences() {
  const found = new Map<string, string>();
  for (const file of FILES) {
    const text = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    for (const re of PATTERNS) for (const m of text.matchAll(re)) {
      const s = m[2]!.replace(/\\(['"])/g, "$1");
      if (s.includes(" ")) found.set(s, file + ":" + text.slice(0, m.index).split("\n").length);
    }
  }
  return found;
}

test("every error sentence the dashboard can receive from the server has a Russian translation", () => {
  const sentences = serverSentences();
  expect(sentences.size).toBeGreaterThan(80);
  const missing = [...sentences].filter(([s]) => !(s in ru)).map(([s, at]) => at + " " + JSON.stringify(s));
  expect(missing).toEqual([]);
});
