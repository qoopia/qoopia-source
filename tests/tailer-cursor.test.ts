/** The session tailer's byte cursor stays on record boundaries. Black-box: the real tailer against a loopback fake Qoopia, synthetic transcript. */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractText } from "../src/ingest/tailer.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tailer-cursor-"));
  const projects = path.join(root, "projects"), dir = path.join(projects, "-w");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "ingest.key"), "q_synthetic", { mode: 0o600 });
  const posts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ingest/allowlist") return Response.json([{ cwd_prefix: "/w", agent_id: "A", autosession_enabled: 1 }]);
    if (url.pathname === "/ingest/session") { posts.push(((await req.json()) as { uuid: string }).uuid); return Response.json({ saved: true }); }
    return new Response("not found", { status: 404 });
  } });
  const file = path.join(dir, "s.jsonl");
  const start = () => {
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "../src/ingest/tailer.ts")], { stdout: "ignore", stderr: "ignore", env: { ...process.env,
      QOOPIA_URL: `http://127.0.0.1:${server.port}`, QOOPIA_INGEST_KEY_PATH: path.join(root, "ingest.key"),
      CLAUDE_PROJECTS_DIR: projects, QOOPIA_CURSORS_PATH: path.join(root, "cursors.json") } });
    cleanup.push(() => { child.kill(); server.stop(true); fs.rmSync(root, { recursive: true, force: true }); });
  };
  const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(100); };
  return { posts, file, start, until };
}
const record = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, sessionId: "S", cwd: "/w",
  timestamp: "2026-10-11T00:00:00.000Z", message: { role: "user", content: text } }) + "\n";

test("an invalid UTF-8 byte does not shift the cursor past the next record (F-520-tailer-utf8)", async () => {
  const t = harness();
  const first = Buffer.from(record("u1", "synthetic @ byte"));
  first[first.indexOf(0x40)] = 0xff;
  fs.writeFileSync(t.file, Buffer.concat([first, Buffer.from(record("u2", "second"))]));
  t.start();
  await t.until(() => t.posts.includes("u2"));
  fs.appendFileSync(t.file, record("u3", "third"));
  await t.until(() => t.posts.includes("u3"));
  await Bun.sleep(2500); // one more sweep: a cursor past the end would replay the file
  expect(t.posts).toEqual(["u1", "u2", "u3"]);
}, 20_000);

test("a transcript replaced under the same name is read from its start (F-520-tailer-inode)", async () => {
  const t = harness();
  fs.writeFileSync(t.file, record("u1", "first") + record("u2", "second"));
  t.start();
  await t.until(() => t.posts.includes("u2"));
  const next = t.file + ".new";
  fs.writeFileSync(next, record("n1", "replacement one, longer than the old file") + record("n2", "replacement two") + record("n3", "three"));
  fs.renameSync(next, t.file);
  await t.until(() => t.posts.includes("n3"));
  expect(t.posts).toEqual(["u1", "u2", "n1", "n2", "n3"]);
}, 20_000);

test("a turn with something secret-shaped is kept with the secret cut out, not dropped whole [M9]", () => {
  const key = "sk-ant-" + "a1B2".repeat(10), bearer = "x9Y8".repeat(8);
  const line = (type: string, content: unknown) => JSON.stringify({ type, uuid: "u", sessionId: "S", cwd: "/w", message: { role: type, content } });
  const kept = (result: ReturnType<typeof extractText>, ...parts: string[]) => {
    expect(result).not.toBeNull();
    for (const part of parts) expect(result!.text).toContain(part);
    for (const secret of [key, bearer, "hunter2hunter2", "abcdefghijklmnopqrstuvwxyz012345"]) expect(result!.text).not.toContain(secret);
  };
  kept(extractText(line("user", `deploy with password=hunter2hunter2 then check ${key} and report back`)), "deploy with", "then check", "and report back");
  kept(extractText(line("user", [{ type: "text", text: `Authorization: Bearer ${bearer} was in the log` }])), "was in the log");
  kept(extractText(line("user", `<channel source="plugin:telegram:telegram" chat_id="1">api_key: abcdefghijklmnopqrstuvwxyz012345 is the staging one</channel>`)), "is the staging one");
  kept(extractText(line("assistant", [{ type: "tool_use", name: "mcp__plugin_telegram_telegram__reply", input: { text: `the key is ${key}, rotate it` } }])), "the key is", "rotate it");
  // Nothing secret: the text is passed on as it was, file paths included.
  expect(extractText(line("user", "open /Users/user/project/app.ts and fix it"))!.text).toBe("open /Users/user/project/app.ts and fix it");
});
