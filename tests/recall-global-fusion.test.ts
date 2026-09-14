process.env.QOOPIA_ENTITY_PAGES = "true";

import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { logActivity } from "../src/services/activity.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { upsertEntity } from "../src/services/entities.ts";
import { recall } from "../src/services/recall.ts";

let workspaceId = "";
let agentId = "";
const marker = "phase3globalfusion";

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({
    name: "Recall Global Fusion",
    slug: "recall-global-fusion",
  });
  workspaceId = workspace.id;
  agentId = createAgent({
    name: "recall-global-agent",
    workspaceSlug: workspace.slug,
  }).id;

  upsertEntity({
    workspace_id: workspaceId,
    type: "protocol",
    slug: marker,
    title: `${marker} canonical protocol`,
    summary: `${marker} exact entity result`,
  });
  for (let index = 0; index < 3; index++) {
    createNote({
      workspace_id: workspaceId,
      agent_id: agentId,
      text: `${marker} note candidate ${index}`,
    });
    logActivity({
      workspace_id: workspaceId,
      agent_id: agentId,
      action: "fusion_test",
      entity_type: "test",
      entity_id: String(index),
      project_id: null,
      summary: `${marker} activity candidate ${index}`,
    });
    saveMessage({
      workspace_id: workspaceId,
      agent_id: agentId,
      session_id: `recall-global-session-${index}`,
      role: "assistant",
      content: `${marker} session candidate ${index}`,
    });
  }
});

describe("recall(scope='all') global fusion", () => {
  test("applies one global limit and mixes independently-ranked sources", async () => {
    const result = await recall({
      workspace_id: workspaceId,
      caller_agent_id: agentId,
      is_admin: false,
      query: marker,
      scope: "all",
      mode: "fts5",
      limit: 4,
    });
    expect(result.total_found).toBe(4);
    expect(result.results.map((row) => row.source)).toEqual([
      "entity",
      "notes",
      "activity",
      "sessions",
    ]);
  });

  test("ties are deterministic across repeated calls", async () => {
    const call = () => recall({
      workspace_id: workspaceId,
      caller_agent_id: agentId,
      is_admin: false,
      query: marker,
      scope: "all" as const,
      mode: "fts5" as const,
      limit: 10,
    });
    const first = await call();
    const second = await call();
    expect(second.results.map((row) => `${row.source}:${row.id}`)).toEqual(
      first.results.map((row) => `${row.source}:${row.id}`),
    );
    expect(first.results.length).toBeLessThanOrEqual(10);
    for (let index = 1; index < first.results.length; index++) {
      expect(first.results[index - 1]!.rank).toBeLessThanOrEqual(
        first.results[index]!.rank,
      );
    }
  });
});
