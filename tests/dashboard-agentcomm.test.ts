/**
 * AC-READ-001: the read-only AgentComm messenger endpoints.
 *   • /api/dashboard/agentcomm/threads — one row per agent pair
 *   • /api/dashboard/agentcomm/thread  — full transcript of one pair
 *
 * Bodies must come back VERBATIM (no truncation). ADR-020: an agent reads a
 * pair it is not part of only while its shared-context toggle is on.
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
import { acPairParams, acPairSql } from "../src/dashboard-api.ts";

let server: Server;
let baseUrl = "";

let WORKSPACE_ID = "";
let LEO_ID = "";
let LEO_KEY = "";
let ALAN_ID = "";
let ALAN_KEY = "";
let OUTSIDER_KEY = "";
let SHARED_KEY = "";
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
  // ADR-020: the outsider's shared context is off; ac-shared keeps the default (on).
  db.query("UPDATE agents SET metadata = json_set(metadata, '$.shared_context', json('false')) WHERE id = ?").run(outsider.id);
  SHARED_KEY = createAgent({ name: "ac-shared", workspaceSlug: ws.slug }).api_key;
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

  test("an uninvolved agent with shared context off sees no threads", async () => {
    const r = await get("/api/dashboard/agentcomm/threads", OUTSIDER_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: any[] };
    expect(body.items.length).toBe(0);
  });

  test("an uninvolved agent with shared context on sees its siblings' threads (ADR-020)", async () => {
    const r = await get("/api/dashboard/agentcomm/threads", SHARED_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: any[] };
    expect(body.items.map((t) => t.pair_key)).toContain([LEO_ID, ALAN_ID].sort().join("|"));
  });

  test("overview AgentComm counts follow the toggle too", async () => {
    const count = async (key: string) =>
      ((await (await get("/api/dashboard/overview", key)).json()) as { comm: { messages_24h: number } }).comm.messages_24h;
    db.query("UPDATE agent_comm_messages SET created_at = ? WHERE id = 'acm_3'").run(new Date().toISOString());
    try {
      expect(await count(SHARED_KEY)).toBeGreaterThan(0);
      expect(await count(OUTSIDER_KEY)).toBe(0);
    } finally {
      db.query("UPDATE agent_comm_messages SET created_at = '2026-08-02T11:00:00Z' WHERE id = 'acm_3'").run();
    }
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
    expect(p1.next_before).toBe("2026-08-02T11:00:00Z|acm_3");

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

  test("an uninvolved agent with shared context off is FORBIDDEN", async () => {
    const r = await get(threadPath(), OUTSIDER_KEY);
    expect(r.status).toBe(403);
  });

  test("an uninvolved agent with shared context on reads the thread in full", async () => {
    const r = await get(threadPath(), SHARED_KEY);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { messages: Array<{ body: string }> };
    expect(body.messages.map((m) => m.body)).toContain(LONG_BODY);
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

// F-192: the transcript names only agents of this workspace or of a pair that has a thread here.
describe("AgentComm transcript names stay inside the workspace", () => {
  const thread = async (a: string, b: string, key: string) =>
    (await (await get(`/api/dashboard/agentcomm/thread?a=${a}&b=${b}`, key)).json()) as any;

  test("ids from another workspace are not resolved to names", async () => {
    const other = createWorkspace({ name: "AgentComm Elsewhere", slug: "agentcomm-elsewhere" });
    const gamma = createAgent({ name: "ac-gamma", workspaceSlug: other.slug }).id;
    const delta = createAgent({ name: "ac-delta", workspaceSlug: other.slug }).id;
    const viaSteward = await thread(gamma, delta, STEWARD_KEY);
    expect([viaSteward.agent_a.name, viaSteward.agent_b.name]).toEqual([null, null]);
    const viaParty = await thread(LEO_ID, gamma, LEO_KEY);
    expect([viaParty.agent_a.name, viaParty.agent_b.name]).toEqual(["ac-leo", null]);
  });

  test("a federated pair with a thread stored here keeps both names", async () => {
    const peerWs = createWorkspace({ name: "AgentComm Peer", slug: "agentcomm-peer" });
    const peer = createAgent({ name: "ac-peer", workspaceSlug: peerWs.slug }).id;
    insertMessage({ id: "acm_fed_1", session_id: "acs_1", sender: LEO_ID, recipient: peer, body: "federated", created_at: "2026-08-04T09:00:00Z" });
    const body = await thread(LEO_ID, peer, STEWARD_KEY);
    expect([body.agent_a.name, body.agent_b.name]).toEqual(["ac-leo", "ac-peer"]);
  });
});

describe("dashboard pages keyset on (created_at, id)", () => {
  async function walk(path: string, key: "messages" | "items", wanted: string[]) {
    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 20 && wanted.some((id) => !seen.includes(id)); page++) {
      const r = await get(`${path}&limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`, STEWARD_KEY);
      const body = (await r.json()) as Record<string, any>;
      seen.push(...body[key].map((row: { id: string }) => row.id));
      before = body.next_before;
      if (!before) break;
    }
    return seen.filter((id) => wanted.includes(id));
  }

  test("every AgentComm message of one second is seen exactly once", async () => {
    const peer = createAgent({ name: "ac-burst", workspaceSlug: "agentcomm-read" }).id;
    const ids = ["acm_burst_1", "acm_burst_2", "acm_burst_3"];
    for (const id of ids) {
      insertMessage({ id, session_id: "acs_1", sender: LEO_ID, recipient: peer, body: id, created_at: "2026-08-03T09:00:00Z" });
    }
    expect((await walk(`/api/dashboard/agentcomm/thread?a=${LEO_ID}&b=${peer}`, "messages", ids)).sort()).toEqual(ids);
  });

  test("every activity row of one second is seen exactly once", async () => {
    const ids = ["act_burst_1", "act_burst_2", "act_burst_3"];
    for (const id of ids) {
      db.prepare(
        `INSERT INTO activity (id, workspace_id, agent_id, action, entity_type, entity_id, summary, details, visibility, created_at)
         VALUES (?, ?, ?, 'probe', 'note', ?, 'burst', '{}', 'workspace', '2099-01-01T00:00:00Z')`,
      ).run(id, WORKSPACE_ID, LEO_ID, id);
    }
    expect((await walk("/api/dashboard/activity?x=1", "items", ids)).sort()).toEqual(ids);
  });

  test("a bare timestamp from an older page still pages; a broken cursor is a 400", async () => {
    const legacy = await get(`${threadPath()}&limit=1&before=${encodeURIComponent("2026-08-02T11:00:00Z")}`, STEWARD_KEY);
    expect(((await legacy.json()) as any).messages.map((m: any) => m.id)).toEqual(["acm_2"]);
    for (const path of [threadPath(), "/api/dashboard/activity?x=1"]) {
      expect((await get(`${path}&before=${encodeURIComponent("2026-08-02T11:00:00Z|")}`, STEWARD_KEY)).status).toBe(400);
    }
  });
});

describe("F-272: pair queries probe the recipient index per direction", () => {
  const plan = (sql: string, params: unknown[]) =>
    (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>).map((r) => r.detail);

  test("last message and transcript page never scan the whole workspace", () => {
    const cursor = " AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))";
    for (const [sql, extra] of [
      [acPairSql("m.id, m.created_at"), []],
      [acPairSql("m.*", cursor), ["2026-08-02T11:00:00Z", "2026-08-02T11:00:00Z", "acm_3"]],
    ] as const) {
      const details = plan(sql, acPairParams(WORKSPACE_ID, LEO_ID, ALAN_ID, [...extra], 5));
      const searches = details.filter((d) => d.startsWith("SEARCH m "));
      expect(searches.length).toBe(2);
      for (const d of searches) expect(d).toContain("recipient_agent_id=?");
      expect(details.join(" ; ")).not.toContain("SCAN m");
    }
  });

  test("a self-addressed pair is listed once", () => {
    insertMessage({ id: "acm_self", session_id: "acs_1", sender: LEO_ID, recipient: LEO_ID, body: "note to self", created_at: "2026-08-04T09:00:00Z" });
    const rows = db.query(acPairSql("m.id, m.created_at")).all(...(acPairParams(WORKSPACE_ID, LEO_ID, LEO_ID, [], 10) as never[])) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["acm_self"]);
    db.prepare(`DELETE FROM agent_comm_messages WHERE id = 'acm_self'`).run();
  });
});
