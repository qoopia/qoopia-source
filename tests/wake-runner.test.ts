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
import { WakeRunner, addWakeRunnerAgent, loadWakeRunnerConfig, wakeRunnerServerEnv, wakeRunnerService, type WakeRunnerConfig } from "../src/delivery/wake-runner.ts";

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
