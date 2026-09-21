import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { createNote } from "../src/services/notes.ts";

let server: Server;
let baseUrl = "";
let STEWARD_KEY = "";
let STANDARD_KEY = "";
let NOTE_ID = "";
const originalFlags = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const name of [
    "QOOPIA_V4_RELATIONS",
    "QOOPIA_V4_LATEST_ONLY",
    "QOOPIA_V4_RECALL_EXPLAIN",
    "QOOPIA_V4_LIFECYCLE",
    "QOOPIA_V4_EXTRACTION",
    "QOOPIA_V4_FEEDBACK",
    "QOOPIA_V4_DASHBOARD",
  ]) {
    originalFlags.set(name, process.env[name]);
    process.env[name] = "true";
  }
  runMigrations();
  const ws = createWorkspace({ name: "dashboard-v4-test" });
  const steward = createAgent({ name: "dashboard-v4-steward", workspaceSlug: ws.slug, type: "steward" });
  const standard = createAgent({ name: "dashboard-v4-standard", workspaceSlug: ws.slug });
  STEWARD_KEY = steward.api_key;
  STANDARD_KEY = standard.api_key;
  NOTE_ID = createNote({
    workspace_id: ws.id,
    agent_id: steward.id,
    text: "dashboard v4 synthetic recall target",
    type: "memory",
  }).id;
  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [name, value] of originalFlags) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function request(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

describe("P07 V4 dashboard API", () => {
  test("dashboard feature flag fails closed", async () => {
    process.env.QOOPIA_V4_DASHBOARD = "false";
    try {
      expect((await request("/api/dashboard/v4/state", STEWARD_KEY)).status).toBe(404);
    } finally {
      process.env.QOOPIA_V4_DASHBOARD = "true";
    }
  });

  test("state is admin-only, workspace-scoped, and omits production controls", async () => {
    expect((await request("/api/dashboard/v4/state", STANDARD_KEY)).status).toBe(403);
    const response = await request("/api/dashboard/v4/state", STEWARD_KEY);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    // Migration 039 adds bridge folders above the memory index.
    // The dashboard must report the highest applied schema, not the old V4 set.
    expect(body.operations.schema_version).toBe(46);
    expect(body.operations.production_apply_controls).toBe(false);
    expect(body.runtime_acceptance.status).toBe("deferred_to_p10");
    expect(body.feature_flags.dashboard).toBe(true);
  });

  test("recall explorer returns visible results and privacy-safe explain data", async () => {
    const response = await request("/api/dashboard/v4/recall", STEWARD_KEY, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qoopia-csrf": "1" },
      body: JSON.stringify({
        query: "dashboard synthetic recall target",
        explain: true,
        trace: true,
        latest_only: true,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.results.some((item: any) => item.id === NOTE_ID)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("api_key");
  });

  test("V4 writes require both allowed origin and explicit CSRF header", async () => {
    const noCsrf = await request("/api/dashboard/v4/feedback", STEWARD_KEY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noCsrf.status).toBe(403);
    const forged = await request("/api/dashboard/v4/feedback", STEWARD_KEY, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qoopia-csrf": "1",
        origin: "https://evil.example.com",
      },
      body: "{}",
    });
    expect(forged.status).toBe(403);
  });

  test("feedback is idempotent and never exposes raw note text in state", async () => {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", "x-qoopia-csrf": "1" },
      body: JSON.stringify({
        note_id: NOTE_ID,
        feedback: "helpful",
        reason_code: "synthetic_relevant",
        idempotency_key: "dashboard-v4-feedback-0001",
      }),
    };
    const first = await request("/api/dashboard/v4/feedback", STEWARD_KEY, init);
    const second = await request("/api/dashboard/v4/feedback", STEWARD_KEY, init);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json() as any;
    const secondBody = await second.json() as any;
    expect(secondBody.feedback_id).toBe(firstBody.feedback_id);
    const state = await (await request("/api/dashboard/v4/state", STEWARD_KEY)).json() as any;
    expect(state.feedback.some((item: any) => item.reason_code === "synthetic_relevant")).toBe(true);
    expect(JSON.stringify(state)).not.toContain("dashboard v4 synthetic recall target");
  });

  test("lifecycle review writes reuse service authorization and require CSRF", async () => {
    const confirm = await request("/api/dashboard/v4/lifecycle-confirm", STEWARD_KEY, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qoopia-csrf": "1" },
      body: JSON.stringify({ note_id: NOTE_ID }),
    });
    expect(confirm.status).toBe(200);
    const pin = await request("/api/dashboard/v4/lifecycle-pin", STEWARD_KEY, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qoopia-csrf": "1" },
      body: JSON.stringify({ note_id: NOTE_ID, pinned: true }),
    });
    expect(pin.status).toBe(200);
    const lifecycle = await (await request(`/api/dashboard/v4/lifecycle?note_id=${NOTE_ID}`, STEWARD_KEY)).json() as any;
    expect(lifecycle.confirmation_count).toBeGreaterThanOrEqual(1);
    expect(lifecycle.owner_pinned).toBe(1);
  });
});
