/**
 * The wake runner closes the loop for agents that are only a CLI on a
 * computer: Qoopia pushes a signed wake, the runner runs a turn, and the turn's
 * answer comes back as the agent's reply — signed with the same binding, to the
 * message it was asked, and never as an answer to an answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import { agentSend } from "../src/services/agent-comm.ts";
import { drainAgentWakeQueue } from "../src/services/agent-wake.ts";
import { wakeReply } from "../src/services/wake-reply.ts";
import { WakeRunner, addWakeRunnerAgent, executableReplaced, wakePrompt, loadWakeRunnerConfig, wakeRunnerServerEnv, wakeRunnerService, loadService, qoopiaMcpServers, runtimeCommand, type WakeRunnerConfig } from "../src/delivery/wake-runner.ts";

let ws = "", alice = "", bob = "", carol = "";
const SECRET_A = "a".repeat(40), SECRET_B = "b".repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-wake-runner-"));
const turns = path.join(tmp, "turns.log");
// A stand-in for `claude -p --output-format json`: records that a turn ran and answers.
const fakeClaude = path.join(tmp, "fake-claude.sh");
fs.writeFileSync(fakeClaude, `#!/bin/sh\nprompt=$(cat)\nprintf '%s\\n' "turn $*" >> '${turns}'\ncase "$prompt" in *"Kind: request"*) a="ANSWER from runtime";; *) a="noted";; esac\nprintf '{"type":"result","is_error":false,"result":"%s","session_id":"sess-1"}\\n' "$a"\n`, { mode: 0o755 });

const envs = ["URL", "SECRET", "AUTH", "AGENT_ID"].flatMap((k) => [`AGENTCOMM_WR_ALICE_WEBHOOK_${k}`, `AGENTCOMM_WR_BOB_WEBHOOK_${k}`]);
let runner: WakeRunner | null = null;

function config(port: number): WakeRunnerConfig {
  return {
    format: "qoopia-wake-runner/1", server: "http://qoopia.test", listen: { host: "127.0.0.1", port }, max_parallel: 2,
    agents: [
      { agent_id: alice, name: "wr-alice", path: "/hooks/agentcomm/wr-alice", secret: SECRET_A, runtime: "claude_code", command: fakeClaude, cwd: tmp, isolated: false, timeout_seconds: 30 },
      { agent_id: bob, name: "wr-bob", path: "/hooks/agentcomm/wr-bob", secret: SECRET_B, runtime: "claude_code", command: fakeClaude, cwd: tmp, isolated: false, timeout_seconds: 30 },
    ],
  };
}

/** The runner's reply POST goes straight into the server handler, as it would over HTTP. */
const replies: { status: number; body: any }[] = [];
const serverFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const raw = Buffer.from(String(init?.body ?? ""));
  const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const result = wakeReply(raw, headers);
  replies.push(result);
  return Response.json(result.body, { status: result.status });
}) as unknown as typeof fetch;

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
}

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Wake Runner", slug: "wake-runner" });
  ws = w.id;
  alice = createAgent({ name: "wr-alice", workspaceSlug: w.slug }).id;
  bob = createAgent({ name: "wr-bob", workspaceSlug: w.slug }).id;
  carol = createAgent({ name: "wr-carol", workspaceSlug: w.slug }).id;
});
beforeEach(async () => {
  await runner?.stop(); runner = null; replies.length = 0;
  for (const k of envs) delete process.env[k];
  fs.rmSync(turns, { force: true });
  db.prepare(`DELETE FROM agent_wake_events WHERE delivered_at IS NULL`).run();
});
afterAll(async () => { await runner?.stop(); for (const k of envs) delete process.env[k]; fs.rmSync(tmp, { recursive: true, force: true }); });

function bind(port: number) {
  for (const [name, id, secret] of [["ALICE", alice, SECRET_A], ["BOB", bob, SECRET_B]] as const) {
    process.env[`AGENTCOMM_WR_${name}_WEBHOOK_URL`] = `http://127.0.0.1:${port}/hooks/agentcomm/wr-${name.toLowerCase()}`;
    process.env[`AGENTCOMM_WR_${name}_WEBHOOK_SECRET`] = secret;
    process.env[`AGENTCOMM_WR_${name}_WEBHOOK_AGENT_ID`] = id;
  }
}

describe("wake runner: the whole loop", () => {
  test("a request wakes the recipient, its turn answers, and the answer wakes the sender without another answer", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    bind(port);
    runner = new WakeRunner(config(port), path.join(tmp, `state-${port}`), serverFetch);
    runner.start();

    const sent = agentSend({ workspace_id: ws, agent_id: alice, to_agent: bob, body: "ping from alice", topic: "loop" });
    expect(sent.wake?.delivery).toBe("waking");
    await drainAgentWakeQueue();
    await until(() => replies.length === 1);
    expect(replies[0]!.status).toBe(200);
    const reply = db.prepare(`SELECT * FROM agent_comm_messages WHERE id = ?`).get(replies[0]!.body.id) as any;
    expect(reply).toMatchObject({ sender_agent_id: bob, recipient_agent_id: alice, kind: "reply", parent_message_id: sent.id, body: "ANSWER from runtime" });
    expect(JSON.parse(reply.metadata)).toMatchObject({ via: "wake-runner", runtime: "claude_code" });
    // The request's wake is a real push: the runtime accepted it.
    expect((db.prepare(`SELECT status FROM agent_wake_events WHERE message_id = ?`).get(sent.id) as any).status).toBe("delivered");

    // The reply wakes alice: a turn runs, and nothing is sent back.
    await drainAgentWakeQueue();
    await until(() => (fs.existsSync(turns) ? fs.readFileSync(turns, "utf8").trim().split("\n").length : 0) === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(replies.length).toBe(1);
    expect((db.prepare(`SELECT status FROM agent_wake_events WHERE message_id = ?`).get(reply.id) as any).status).toBe("delivered");
    const log = fs.readFileSync(path.join(tmp, `state-${port}`, "runner.log"), "utf8");
    expect(log).toContain('"event":"turn_finished"');
    expect(log).not.toContain("ping from alice");
  });

  test("a second turn in the same AgentComm session resumes the runtime session", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    bind(port);
    runner = new WakeRunner(config(port), path.join(tmp, `state-${port}`), serverFetch);
    runner.start();
    const first = agentSend({ workspace_id: ws, agent_id: carol, to_agent: bob, body: "one", topic: "resume" });
    await drainAgentWakeQueue();
    await until(() => replies.length === 1);
    agentSend({ workspace_id: ws, agent_id: carol, to_agent: bob, body: "two", session_id: first.session_id });
    await drainAgentWakeQueue();
    await until(() => replies.length === 2);
    const lines = fs.readFileSync(turns, "utf8").trim().split("\n");
    expect(lines[0]).toContain("--session-id");
    expect(lines[1]).toContain("--resume sess-1");
  });
});

describe("wake runner: recovery", () => {
  test("a runtime session that cannot be resumed is forgotten once and the turn runs in a new one [A2-06]", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    bind(port);
    // A runtime whose stored history is gone: every --resume fails.
    const lost = path.join(tmp, "fake-claude-lost.sh");
    fs.writeFileSync(lost, `#!/bin/sh\ncase "$*" in *--resume*) printf '%s\\n' "turn $*" >> '${turns}'; echo 'No conversation found' >&2; exit 1;; esac\nexec '${fakeClaude}' "$@"\n`, { mode: 0o755 });
    const c = config(port);
    c.agents[1] = { ...c.agents[1]!, command: lost };
    runner = new WakeRunner(c, path.join(tmp, `state-${port}`), serverFetch);
    runner.start();
    const first = agentSend({ workspace_id: ws, agent_id: carol, to_agent: bob, body: "one", topic: "lost history" });
    await drainAgentWakeQueue();
    await until(() => replies.length === 1);
    agentSend({ workspace_id: ws, agent_id: carol, to_agent: bob, body: "two", session_id: first.session_id });
    await drainAgentWakeQueue();
    await until(() => replies.length === 2);
    const lines = fs.readFileSync(turns, "utf8").trim().split("\n");
    expect(lines.map((l) => l.includes("--resume") ? "resume" : l.includes("--session-id") ? "new" : "?")).toEqual(["new", "resume", "new"]);
    expect(replies[1]!.status).toBe(200);
    expect((db.prepare(`SELECT body FROM agent_comm_messages WHERE id = ?`).get(replies[1]!.body.id) as any).body).toBe("ANSWER from runtime");
    expect(fs.readFileSync(path.join(tmp, `state-${port}`, "runner.log"), "utf8")).toContain('"event":"resume_reset"');
  });

  test("an answer survives a server that is down longer than the turn, and is sent when it returns [A2-07]", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    bind(port);
    let down = 6;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (down > 0) { down--; return Response.json({ error: "unavailable" }, { status: 503 }); }
      return serverFetch(url, init);
    }) as unknown as typeof fetch;
    const state = path.join(tmp, `state-${port}`);
    runner = new WakeRunner(config(port), state, flaky, 40);
    runner.start();
    agentSend({ workspace_id: ws, agent_id: carol, to_agent: bob, body: "answer me later", topic: "outage" });
    await drainAgentWakeQueue();
    await until(() => replies.length === 1);
    expect(replies[0]!.status).toBe(200);
    expect(down).toBe(0);
    expect(fs.readdirSync(path.join(state, "replies"))).toEqual([]);
  });

  test("a job file that cannot be read is set aside and the agent still wakes for the next message [A1-04]", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    bind(port);
    const state = path.join(tmp, `state-${port}`);
    fs.mkdirSync(path.join(state, "spool", bob), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(state, "spool", bob, "0000-broken.json"), "{not json", { mode: 0o600 });
    runner = new WakeRunner(config(port), state, serverFetch);
    runner.start();
    agentSend({ workspace_id: ws, agent_id: carol, to_agent: bob, body: "after the broken file", topic: "broken spool" });
    await drainAgentWakeQueue();
    await until(() => replies.length === 1);
    expect(fs.readdirSync(path.join(state, "spool", bob, "rejected"))).toEqual(["0000-broken.json"]);
    expect(fs.readdirSync(path.join(state, "spool", bob)).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  test("the workspace canon sent with a wake is in the prompt before the quoted message", async () => {
    const job = { message_id: "M1", session_id: "S1", from_agent: "x", from_agent_id: "x", topic: "t", kind: "request", body: "the body", created_at: "now" };
    const prompt = wakePrompt({ name: "bob" }, { ...job, canon_text: "Rule 1: answer in Russian.\nRule 2: never deploy without GO." });
    expect(prompt.indexOf("Rule 1: answer in Russian.")).toBeGreaterThan(0);
    expect(prompt.indexOf("Rule 2: never deploy without GO.")).toBeLessThan(prompt.indexOf("From: x"));
    expect(prompt).toContain("> the body");
    expect(wakePrompt({ name: "bob" }, job)).not.toContain("canon");
    // Through the runner: the canon in the wake payload reaches the spooled job and the turn's stdin.
    const port = 20000 + Math.floor(Math.random() * 20000);
    const seen = path.join(tmp, `prompt-${port}.txt`);
    const capture = path.join(tmp, `fake-claude-capture-${port}.sh`);
    fs.writeFileSync(capture, `#!/bin/sh\ncat > '${seen}'\nprintf '{"type":"result","is_error":false,"result":"ok","session_id":"s"}\\n'\n`, { mode: 0o755 });
    const c = config(port); c.agents[1] = { ...c.agents[1]!, command: capture };
    runner = new WakeRunner(c, path.join(tmp, `state-${port}`), serverFetch);
    runner.start();
    const wake = JSON.stringify({ event_type: "agentcomm_wake", to_agent_id: bob, canon_text: "CANON: be brief.", messages: [{ ...job, message_id: "MCANON", kind: "status" }] });
    const response = await fetch(`http://127.0.0.1:${port}/hooks/agentcomm/wr-bob`, { method: "POST", body: wake,
      headers: { "x-webhook-signature": createHmac("sha256", SECRET_B).update(wake).digest("hex") } });
    expect(await response.json()).toEqual({ accepted: true, queued: 1 });
    await until(() => fs.existsSync(seen) && fs.readFileSync(seen, "utf8").includes("> the body"));
    const text = fs.readFileSync(seen, "utf8");
    expect(text.indexOf("CANON: be brief.")).toBeLessThan(text.indexOf("> the body"));
  });

  test("a binary replaced under the running runner is detected; a deleted one is not a replacement [A7-02]", () => {
    const file = path.join(tmp, "qoopia-binary");
    fs.writeFileSync(file, "old");
    const ino = fs.statSync(file).ino;
    expect(executableReplaced(file, ino)).toBe(false);
    fs.writeFileSync(file + ".new", "new"); fs.renameSync(file + ".new", file);
    expect(executableReplaced(file, ino)).toBe(true);
    fs.rmSync(file);
    expect(executableReplaced(file, ino)).toBe(false);
  });
});

describe("wake runner: refusals", () => {
  test("a bad signature, another agent's wake and a replayed message are not accepted as new work", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    runner = new WakeRunner(config(port), path.join(tmp, `state-${port}`), serverFetch);
    runner.start();
    const url = `http://127.0.0.1:${port}/hooks/agentcomm/wr-bob`;
    const wake = JSON.stringify({ event_type: "agentcomm_wake", to_agent_id: bob, messages: [{ message_id: "M1", session_id: "S1",
      from_agent: "x", from_agent_id: "x", topic: "t", kind: "status", body: "b", created_at: "now" }] });
    const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");
    expect((await fetch(url, { method: "POST", body: wake, headers: { "x-webhook-signature": sign(SECRET_A, wake) } })).status).toBe(401);
    const other = wake.replace(bob, alice);
    expect((await fetch(url, { method: "POST", body: other, headers: { "x-webhook-signature": sign(SECRET_B, other) } })).status).toBe(403);
    const ok = await fetch(url, { method: "POST", body: wake, headers: { "x-webhook-signature": sign(SECRET_B, wake) } });
    expect(await ok.json()).toEqual({ accepted: true, queued: 1 });
    await until(() => fs.existsSync(turns));
    await new Promise((r) => setTimeout(r, 100));
    const again = await fetch(url, { method: "POST", body: wake, headers: { "x-webhook-signature": sign(SECRET_B, wake) } });
    expect(await again.json()).toEqual({ accepted: true, queued: 0 });
  });

  test("the reply callback answers only for a bound agent, with its own secret, to a message it received", () => {
    const sent = agentSend({ workspace_id: ws, agent_id: carol, to_agent: bob, body: "ask bob", topic: "cb" });
    const call = (secret: string, body: object, extra: Record<string, string> = {}) => {
      const raw = Buffer.from(JSON.stringify(body));
      return wakeReply(raw, { "x-webhook-signature": createHmac("sha256", secret).update(raw).digest("hex"), ...extra });
    };
    const body = { agent_id: bob, reply_to_message_id: sent.id, body: "hi", idempotency_key: "cb-1" };
    // Without AGENT_ID binding a name proves nothing.
    process.env.AGENTCOMM_WR_BOB_WEBHOOK_SECRET = SECRET_B;
    expect(call(SECRET_B, body).status).toBe(401);
    process.env.AGENTCOMM_WR_BOB_WEBHOOK_AGENT_ID = bob;
    expect(call(SECRET_A, body).status).toBe(401);
    expect(call(SECRET_B, { ...body, reply_to_message_id: "nope" }).status).toBe(404);
    const toAlice = agentSend({ workspace_id: ws, agent_id: carol, to_agent: alice, body: "not for bob", topic: "cb" });
    expect(call(SECRET_B, { ...body, reply_to_message_id: toAlice.id }).status).toBe(404);
    const ok = call(SECRET_B, body);
    expect(ok.status).toBe(200);
    expect(call(SECRET_B, body).body.id).toBe(ok.body.id);
  });
});

describe("wake runner: config", () => {
  test("secrets live only in a private file and in the server env file", () => {
    const file = path.join(tmp, "runner.json");
    addWakeRunnerAgent(file, { server: "https://mcp.example", host: "127.0.0.1", port: "8790", agent_id: "A1", name: "Qoopia Claude memory",
      runtime: "claude_code", command: fakeClaude, cwd: tmp });
    const out = addWakeRunnerAgent(file, { agent_id: "G1", name: "GPT", runtime: "codex", command: fakeClaude, cwd: tmp, isolated: true });
    expect(JSON.stringify(out)).not.toMatch(/secret/i);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const loaded = loadWakeRunnerConfig(file);
    expect(loaded.agents.map((a) => a.path)).toEqual(["/hooks/agentcomm/qoopia-claude-memory", "/hooks/agentcomm/gpt"]);
    const env = wakeRunnerServerEnv(loaded);
    expect(env).toContain("AGENTCOMM_QOOPIA_CLAUDE_MEMORY_WEBHOOK_AGENT_ID=A1");
    expect(env).toContain("AGENTCOMM_GPT_WEBHOOK_URL=http://127.0.0.1:8790/hooks/agentcomm/gpt");
    fs.chmodSync(file, 0o644);
    expect(() => loadWakeRunnerConfig(file)).toThrow(/mode 600/);
  });

  test("the service log never makes launchd create the private state folder", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const service = wakeRunnerService("/opt/q/qoopia", "/home/example/wr/config.json", platform, "/home/example");
      expect(service.bytes).not.toContain("wake-runner-state");
      expect(service.bytes).toMatch(/wake-runner.{0,20}serve/);
    }
    expect(wakeRunnerService("/opt/q/qoopia", "/home/example/wr/config.json", "darwin", "/home/example").bytes).toContain("/home/example/wr/wake-runner.err");
  });
});

test('a reinstall waits for launchd to let the old job go instead of leaving the service unloaded', () => {
  const calls: string[] = [];let busy = 2;
  const spawn = (cmd: string, args: string[]) => {
    calls.push(args[0]!);
    if (args[0] === 'bootstrap' && busy-- > 0) return { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
    return { status: args[0] === 'bootout' ? 3 : 0, stderr: '' };
  };
  const load = [['/bin/launchctl', 'bootout', 'gui/501/ai.qoopia.wake-runner'], ['/bin/launchctl', 'bootstrap', 'gui/501']];
  loadService(load, '/x.plist', spawn, () => {});
  expect(calls).toEqual(['bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
  // Any other bootstrap failure is reported at once, not retried.
  expect(() => loadService(load, '/x.plist', () => ({ status: 1, stderr: 'Bootstrap failed: 37: Operation already in progress' }), () => {})).toThrow('bootstrap failed');
});

test('a woken turn loses agent_send/agent_reply on the Qoopia server whatever the client calls it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-wr-names-')), cwd = path.join(home, 'work');
  fs.mkdirSync(cwd);
  const server = 'https://memory.example.test';
  // Claude: a user-scope entry named by the owner, a project-local entry by its address only, a stdio
  // client of the Qoopia binary and an unrelated server.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { qoopia: { type: 'http', url: server + '/mcp?profile=full' }, github: { command: '/bin/gh-mcp' } },
    projects: { [cwd]: { mcpServers: { 'my memory': { type: 'http', url: server + '/mcp/c/abc' } } } },
  }));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: '/opt/q/qoopia', args: ['mcp'] } } }));
  const env = { HOME: home } as NodeJS.ProcessEnv;
  const claudeNames = qoopiaMcpServers('claude_code', cwd, server, env);
  expect(claudeNames.sort()).toEqual(['local', 'my memory', 'qoopia']);
  const agent = { agent_id: 'A', name: 'a', path: '/hooks/a', secret: 'x'.repeat(40), runtime: 'claude_code' as const, command: '/bin/claude', cwd, isolated: false, timeout_seconds: 60 };
  const claude = runtimeCommand(agent, undefined, '/tmp/last', claudeNames).args;
  const blocked = claude.slice(claude.indexOf('--disallowedTools') + 1);
  for (const s of ['qoopia', 'my_memory', 'local', 'qoopia_memory']) expect(blocked).toEqual(expect.arrayContaining([`mcp__${s}__agent_send`, `mcp__${s}__agent_reply`]));
  expect(blocked.some((t) => t.includes('github'))).toBe(false);

  // Codex: the server from config.toml, under its own name.
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[mcp_servers.qoopia]\nurl = "${server}/mcp"\n[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n`);
  const codexNames = qoopiaMcpServers('codex', cwd, server, env);
  expect(codexNames).toEqual(['qoopia']);
  const codex = runtimeCommand({ ...agent, runtime: 'codex' }, undefined, '/tmp/last', codexNames).args;
  expect(codex).toEqual(expect.arrayContaining(['-c', 'mcp_servers.qoopia.disabled_tools=["agent_send","agent_reply"]']));
  expect(codex.join(' ')).not.toContain('mcp_servers.docs');
  // An isolated turn loads no user MCP server at all, so it gets no override that would define one.
  expect(runtimeCommand({ ...agent, runtime: 'codex', isolated: true }, undefined, '/tmp/last', codexNames).args.join(' ')).not.toContain('disabled_tools');
  fs.rmSync(home, { recursive: true, force: true });
});
