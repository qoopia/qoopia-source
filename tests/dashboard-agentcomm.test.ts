/**
 * AC-READ-001: the read-only AgentComm messenger endpoints.
 *   • /api/dashboard/agentcomm/threads — one row per agent pair
 *   • /api/dashboard/agentcomm/thread  — full transcript of one pair
 *
 * Bodies must come back VERBATIM (no truncation), and standard agents must
 * not be able to read a pair they are not part of.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";

let server: Server;
let baseUrl = "";

let WORKSPACE_ID = "";
let LEO_ID = "";
let LEO_KEY = "";
let ALAN_ID = "";
let ALAN_KEY = "";
let OUTSIDER_KEY = "";
let STEWARD_KEY = "";

// Long enough to prove nothing clips it at 160/280 chars.
const LONG_BODY =
  "П".repeat(50) + "\n\n" + "full body line ".repeat(120) + "\nEND-OF-LONG-BODY";

function insertMessage(opts: {
  id: string;
  session_id: string;
  sender: string;
  recipient: string;
  body: string;
  created_at: string;
  kind?: string;
}) {
  db.prepare(
    `INSERT INTO agent_comm_messages
       (id, workspace_id, session_id, sender_agent_id, recipient_agent_id,
        kind, body, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    opts.id,
    WORKSPACE_ID,
    opts.session_id,
    opts.sender,
    opts.recipient,
    opts.kind ?? "request",
    opts.body,
    opts.created_at,
  );
}

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "AgentComm Read", slug: "agentcomm-read" });
  WORKSPACE_ID = ws.id;

  const leo = createAgent({ name: "ac-leo", workspaceSlug: ws.slug });
  LEO_ID = leo.id;
  LEO_KEY = leo.api_key;
  const alan = createAgent({ name: "ac-alan", workspaceSlug: ws.slug });
  ALAN_ID = alan.id;
  ALAN_KEY = alan.api_key;
  const outsider = createAgent({ name: "ac-outsider", workspaceSlug: ws.slug });
  OUTSIDER_KEY = outsider.api_key;
  const steward = createAgent({
    name: "ac-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  });
  STEWARD_KEY = steward.api_key;

  db.prepare(
    `INSERT INTO agent_comm_sessions
       (id, workspace_id, topic, status, created_by_agent_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, '{}', ?, ?)`,
  ).run(
    "acs_1",
    WORKSPACE_ID,
    "release coordination",
    LEO_ID,
    "2026-08-01T10:00:00Z",
    "2026-08-02T11:00:00Z",
  );

  // Two days of Leo ↔ Alan traffic, both directions.
  insertMessage({
    id: "acm_1",
    session_id: "acs_1",
    sender: LEO_ID,
    recipient: ALAN_ID,
    body: "day one from leo",
    created_at: "2026-08-01T10:00:00Z",
  });
  insertMessage({
    id: "acm_2",
    session_id: "acs_1",
    sender: ALAN_ID,
    recipient: LEO_ID,
    body: LONG_BODY,
    created_at: "2026-08-01T10:05:00Z",
  });
  insertMessage({
    id: "acm_3",
    session_id: "acs_1",
    sender: LEO_ID,
    recipient: ALAN_ID,
    body: "day two from leo",
    created_at: "2026-08-02T11:00:00Z",
  });

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string, token: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

const threadPath = () =>
  `/api/dashboard/agentcomm/thread?a=${LEO_ID}&b=${ALAN_ID}`;

describe("AC-READ-001: AgentComm threads", () => {
  test("steward sees the Leo↔Alan pair with a preview and a count", async () => {
    const r = await get("/api/dashboard/agentcomm/threads", STEWARD_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: any[] };
    const pair = body.items.find(
      (t) =>
        [t.agent_a.id, t.agent_b.id].includes(LEO_ID) &&
        [t.agent_a.id, t.agent_b.id].includes(ALAN_ID),
    );
    expect(pair).toBeDefined();
    expect(pair.message_count).toBe(3);
    expect(pair.last_message_at).toBe("2026-08-02T11:00:00Z");
    expect(pair.last_message.preview).toBe("day two from leo");
    expect(pair.agent_a.name).toBeTruthy();
    expect(pair.agent_b.name).toBeTruthy();
  });

  test("threads are ordered newest first", async () => {
    insertMessage({
      id: "acm_other",
      session_id: "acs_1",
      sender: ALAN_ID,
      recipient: LEO_ID,
      body: "newest",
      created_at: "2026-08-09T09:00:00Z",
    });
    const r = await get("/api/dashboard/agentcomm/threads", STEWARD_KEY);
    const body = (await r.json()) as { items: any[] };
    const times = body.items.map((t) => t.last_message_at);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
    db.prepare(`DELETE FROM agent_comm_messages WHERE id = 'acm_other'`).run();
  });

  test("a party to the conversation sees it in its own thread list", async () => {
    const r = await get("/api/dashboard/agentcomm/threads", LEO_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: any[] };
    expect(body.items.length).toBe(1);
    expect([body.items[0].agent_a.id, body.items[0].agent_b.id]).toContain(
      ALAN_ID,
    );
  });

  test("an uninvolved standard agent sees no threads", async () => {
    const r = await get("/api/dashboard/agentcomm/threads", OUTSIDER_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: any[] };
    expect(body.items.length).toBe(0);
  });

  test("unauthenticated requests are rejected", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agentcomm/threads`);
    expect(r.status).toBe(401);
  });
});

describe("AC-READ-001: AgentComm transcript", () => {
  test("returns both directions in chronological order", async () => {
    const r = await get(threadPath(), STEWARD_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { messages: any[]; total: number };
    expect(body.total).toBe(3);
    expect(body.messages.map((m) => m.id)).toEqual(["acm_1", "acm_2", "acm_3"]);
    expect(body.messages[0].sender_name).toBe("ac-leo");
    expect(body.messages[1].sender_name).toBe("ac-alan");
    expect(body.messages[0].topic).toBe("release coordination");
  });

  test("message bodies are returned in FULL — no truncation, no ellipsis", async () => {
    const r = await get(threadPath(), STEWARD_KEY);
    const body = (await r.json()) as { messages: any[] };
    const long = body.messages.find((m) => m.id === "acm_2");
    expect(long.body).toBe(LONG_BODY);
    expect(long.body.length).toBeGreaterThan(1000);
    expect(long.body.endsWith("END-OF-LONG-BODY")).toBe(true);
    expect(long.body).not.toContain("…");
  });

  test("exposes delivered_at and never ack_status", async () => {
    const r = await get(threadPath(), STEWARD_KEY);
    const body = (await r.json()) as { messages: any[] };
    for (const m of body.messages) {
      expect(m).toHaveProperty("delivered_at");
      expect(m).not.toHaveProperty("ack_status");
      expect(m).not.toHaveProperty("acked_at");
    }
  });

  test("date pagination walks backwards and reports the cursor", async () => {
    const first = await get(`${threadPath()}&limit=1`, STEWARD_KEY);
    const p1 = (await first.json()) as any;
    expect(p1.messages.map((m: any) => m.id)).toEqual(["acm_3"]);
    expect(p1.has_more).toBe(true);
    expect(p1.next_before).toBe("2026-08-02T11:00:00Z");

    const second = await get(
      `${threadPath()}&limit=1&before=${encodeURIComponent(p1.next_before)}`,
      STEWARD_KEY,
    );
    const p2 = (await second.json()) as any;
    expect(p2.messages.map((m: any) => m.id)).toEqual(["acm_2"]);
    // Older page still carries the full body.
    expect(p2.messages[0].body).toBe(LONG_BODY);
  });

  test("a party to the conversation can read it", async () => {
    const r = await get(threadPath(), ALAN_KEY);
    expect(r.status).toBe(200);
  });

  test("an uninvolved standard agent is FORBIDDEN", async () => {
    const r = await get(threadPath(), OUTSIDER_KEY);
    expect(r.status).toBe(403);
  });

  test("missing agent ids are a 400", async () => {
    const r = await get(
      `/api/dashboard/agentcomm/thread?a=${LEO_ID}`,
      STEWARD_KEY,
    );
    expect(r.status).toBe(400);
  });

  test("the endpoints are GET-only", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agentcomm/threads`, {
      method: "POST",
      headers: { authorization: `Bearer ${STEWARD_KEY}` },
    });
    expect(r.status).toBe(405);
  });
});
