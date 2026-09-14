import { expect, test } from "bun:test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { accepted, assigned, loopFixture } from "./helpers/p2-fixtures.ts";
import { loopView, updateAssignment } from "../src/skills/loop.ts";

const dashboard = fs.readFileSync(new URL("../src/public/dashboard.html", import.meta.url), "utf8");
const http = fs.readFileSync(new URL("../src/http.ts", import.meta.url), "utf8");
const has = (source: string, marker: string) => expect(source.includes(marker)).toBe(true);
const lacks = (source: string, marker: string) => expect(source.includes(marker)).toBe(false);

test("V1 dashboard offers email and Google before advanced local recovery", () => {
  has(dashboard, 'id="emailLoginForm"');
  has(dashboard, 'id="googleLoginBtn"');
  has(dashboard, 'id="ownerCodeInput"');
  has(dashboard, "ownerLoginForm').onsubmit");
  has(dashboard, "/api/dashboard/local-login");
  has(dashboard, "JSON.stringify({code})");
  has(dashboard, "Advanced: local recovery and agent access");
  expect(dashboard.indexOf('id="emailLoginForm"')).toBeLessThan(dashboard.indexOf('id="ownerCodeInput"'));
  expect(dashboard.indexOf('id="ownerCodeInput"')).toBeLessThan(dashboard.indexOf('id="tokenInput"'));
  has(http, "return serveDashboard(req,res);");
});

test("V1 dashboard connects memory without adding a task composer", () => {
  lacks(dashboard, "Arbitrary shell");
  lacks(dashboard, "['shell']");
  has(dashboard, "/api/dashboard/memory");
  has(dashboard, "data-memory-client");
  lacks(dashboard, 'id="workTask"');
});

test("V1 dashboard interactive collections use native single-click controls", () => {
  for (const marker of [
    '<button type="button" class="agent-card"',
    '<button type="button" class="sess-item"',
    '<button type="button" class="tg-chat"',
    '<button type="button" class="ent"',
    'class="msg search-result"',
  ]) has(dashboard, marker);
  lacks(dashboard, "addEventListener('dblclick'");
  has(dashboard, ":focus-visible");
});

test("V1 dashboard resolves loading and reconciles failed mutations without discarding inputs", () => {
  has(dashboard, "Could not load the overview.");
  has(dashboard, "if (!r.ok) throw new Error");
  has(dashboard, "await filesLoadList()");
  has(dashboard, "await skillReconcile()");
  has(dashboard, "Your edits are kept");
});

test("skill loop marks only compatible current assignments ready and explains blockers", () => {
  const f = loopFixture();
  try {
    const version = accepted(f);
    const assignment = assigned(f, version);
    let view = loopView(f.auth, { skill_id: version.version.skill_id }, f.database);
    expect(view.registrations[0].readiness.assignable).toBe(true);
    expect(view.assignments[0].readiness).toEqual({ ready: true, blockers: [] });
    expect(view.approvals.find((approval: any) => approval.id === version.approval)?.readiness.ready).toBe(true);

    updateAssignment(f.auth, {
      assignment_id: assignment.data.assignment_id,
      desired_state: "paused",
      reason: "focused readiness regression",
      expected_revision: 1,
      idempotency_key: randomUUID(),
    }, f.database);
    view = loopView(f.auth, { skill_id: version.version.skill_id }, f.database);
    expect(view.assignments[0].readiness.ready).toBe(false);
    expect(view.assignments[0].readiness.blockers.join(" ")).toContain("paused");
  } finally {
    f.database.close();
  }
});

test("global dashboard search reuses scoped message and note APIs", () => {
  has(dashboard, "/search?q=");
  has(dashboard, "/notes?limit=500");
  has(dashboard, "Context note");
  has(dashboard, 'aria-live="polite"');
});

test("overview and skill UI render readiness returned by the server", () => {
  for (const field of ["owner_bound", "connected_agents", "compatible_runtimes", "runnable_runtimes", "active_assignments", "runs", "outcomes"])
    has(dashboard, `j.${field}`);
  has(dashboard, "a.readiness?.ready");
  has(dashboard, "a.readiness?.blockers");
});
