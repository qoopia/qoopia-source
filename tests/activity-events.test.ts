// A4-02: activity rows carry an event code and its parameters; the dashboard and activity_list phrase
// the event from them instead of the server's English summary with raw ids.
import { beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { ACTIVITY_EVENTS, listActivity, logActivity } from "../src/services/activity.ts";
import { v2Create } from "../src/mcp/compat.ts";
import { dashboardScript } from "./helpers/dashboard-source.ts";

const ru: Record<string, string> = JSON.parse(readFileSync(new URL("../src/public/brand/i18n.ru.json", import.meta.url), "utf8"));
const code = dashboardScript.slice(dashboardScript.indexOf("  const NOTE_EVENTS"), dashboardScript.indexOf("  // One line per event"));
const QI = { msg: (s: string, p: Record<string, unknown> = {}) => { expect(ru[s], s).toBeString(); return ru[s]!.replace(/\{(\w+)\}/g, (_, k) => String(p[k])); } };
const { activityText, ACTIVITY_EVENTS: dashboardEvents } = runInNewContext(code + ";({activityText,ACTIVITY_EVENTS})", { QI });

let WS = "", AGENT = "", STEWARD = "";
beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Activity events", slug: "activity-events" });
  WS = ws.id;
  AGENT = createAgent({ name: "events-agent", workspaceSlug: ws.slug }).id;
  STEWARD = createAgent({ name: "events-steward", workspaceSlug: ws.slug, type: "steward" }).id;
});

test("every event code has a Russian sentence on the dashboard, with every parameter filled", () => {
  expect(Object.keys(dashboardEvents).sort()).toEqual([...ACTIVITY_EVENTS].sort());
  const params = { name: "Liam", folder: "inbox", topic: "Релиз", role: "ops", tokens: 2, from: "standard", to: "full" };
  for (const event of ACTIVITY_EVENTS) {
    const text = activityText({ event, params, summary: "English summary 01M4MNWQV43XF4Y0TEMNJK8SQX" });
    expect(text, event).not.toMatch(/[{}]|01M4|English/);
  }
  expect(activityText({ event: "agentcomm.wake.woken", params: { name: "Liam" }, summary: "AgentComm wake delivered for Liam" })).toBe("Liam: агент разбужен ради нового сообщения");
});

test("Qoopia's own activity writes all name their event; only an agent's hand-written entry and legacy note rows do not", () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk(new URL("../src", import.meta.url).pathname);
  const missing: string[] = [];
  let seen = 0;
  for (const file of files) {
    if (/(mcp\/compat|services\/notes|services\/activity)\.ts$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/logActivity\(\{([\s\S]*?)\}\);/g)) { seen++; if (!/\bevent:/.test(m[1]!)) missing.push(file + ": " + m[1]!.slice(0, 80)); }
  }
  expect(missing).toEqual([]);
  expect(seen).toBeGreaterThanOrEqual(15);
});

test("activity_list returns the code and parameters next to the summary; legacy note rows are mapped, agent text is not", () => {
  logActivity({ workspace_id: WS, agent_id: AGENT, action: "agent_wake_delivered", event: "agentcomm.wake.woken", params: { name: "Liam" }, entity_type: "agent_wake_event", entity_id: null, project_id: null, summary: "AgentComm wake delivered for Liam", details: { to: "Liam" } });
  logActivity({ workspace_id: WS, agent_id: AGENT, action: "created", entity_type: "note", entity_id: "01M4", project_id: null, summary: "Created note 01M4" });
  const auth = { agent_id: STEWARD, agent_name: "events-steward", workspace_id: WS, type: "steward" as const, source: "api-key" as const, tool_profile: "full" };
  // A hand-written audit entry cannot claim a phrased event.
  v2Create({ entity: "activity", action: "manual", entity_type: "task", summary: "Выкатил сборку", details: { event: "agent.onboarded", params: { name: "x" } } }, auth as never);
  const items = listActivity({ workspace_id: WS, caller_agent_id: STEWARD, is_admin: true }).items as Array<{ summary: string; event: string | null; params: unknown }>;
  const by = (summary: string) => items.find(i => i.summary === summary)!;
  expect(by("AgentComm wake delivered for Liam")).toMatchObject({ event: "agentcomm.wake.woken", params: { name: "Liam" } });
  expect(by("Created note 01M4")).toMatchObject({ event: "note.created", params: {} });
  expect(by("Выкатил сборку")).toMatchObject({ event: null, params: null });
});
