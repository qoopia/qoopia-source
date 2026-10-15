// Audit 5.0.21 A3b: injection and TOCTOU hardening.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { createAgent } from "../src/admin/agents.ts";
import { agentDirectory, readAgentArtifact } from "../src/services/my-agent.ts";
import { wakeRouteFor } from "../src/services/agent-wake.ts";
import { durableWrite, privateDirectory } from "../src/utils/fs.ts";

beforeAll(() => runMigrations());

test("A3b-01: a folder swapped for a link around the open never serves a file outside the agent folder", () => {
  db.query("INSERT INTO workspaces(id,name,slug) VALUES('toctou-owner','toctou-owner','toctou-owner')").run();
  const owner = bootstrapOwner(db, "TOCTOU owner", undefined, "toctou-owner");
  const agent = createAgent({ name: "TOCTOU steward", workspaceSlug: "toctou-owner", type: "steward" });
  db.query("INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)").run(owner.agent_id, owner.workspace_id, agent.id, "now");
  const folder = agentDirectory(owner.agent_id), workspace = privateDirectory(path.join(folder, "workspace"));
  const inner = privateDirectory(path.join(workspace, "sub")), parked = path.join(workspace, "parked");
  const outside = privateDirectory(path.join(folder, "outside"));
  durableWrite(path.join(inner, "a.txt"), "inside!");
  durableWrite(path.join(outside, "a.txt"), "SECRET!");
  expect(readAgentArtifact(owner.agent_id, "sub/a.txt").bytes.toString()).toBe("inside!");

  // The race: after every name check passes, "sub" becomes a link to the outside folder; it is put
  // back right after the open, so path checks made later see the original folder again.
  const realLstat = fs.lstatSync.bind(fs), realOpen = fs.openSync.bind(fs);
  let lstats = 0;
  const lstat = spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    if (String(target).endsWith(`${path.sep}sub${path.sep}a.txt`) && ++lstats === 2) {
      fs.renameSync(inner, parked);
      fs.symlinkSync(outside, inner);
    }
    return (realLstat as (...a: unknown[]) => fs.Stats)(target, ...rest);
  }) as typeof fs.lstatSync);
  const open = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    const fd = (realOpen as (...a: unknown[]) => number)(target, ...rest);
    if (fs.existsSync(parked)) { fs.unlinkSync(inner); fs.renameSync(parked, inner); }
    return fd;
  }) as typeof fs.openSync);
  try {
    let served = "";
    try { served = readAgentArtifact(owner.agent_id, "sub/a.txt").bytes.toString(); } catch { /* refused */ }
    expect(lstats).toBeGreaterThanOrEqual(2);
    expect(served).not.toBe("SECRET!");
  } finally {
    lstat.mockRestore();
    open.mockRestore();
  }
});

test("A3b-04: a bearer webhook goes out only over https or loopback", () => {
  const ws = "bearer-wake";
  db.query("INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)").run(ws, ws, ws);
  const target = createAgent({ name: "bearer-wake-target", workspaceSlug: ws });
  const prefix = "AGENTCOMM_BEARER_WAKE_TARGET_WEBHOOK";
  const keys = ["URL", "SECRET", "AUTH", "AGENT_ID"];
  const route = (url: string, auth: string) => {
    Object.assign(process.env, { [`${prefix}_URL`]: url, [`${prefix}_SECRET`]: "synthetic-secret", [`${prefix}_AUTH`]: auth, [`${prefix}_AGENT_ID`]: target.id });
    return wakeRouteFor({ id: target.id, name: "bearer-wake-target", workspace_id: ws });
  };
  try {
    expect(route("http://203.0.113.5:9000/wake", "bearer")).toEqual({ route: "none", reason: "insecure_bearer_webhook" });
    expect(route("http://runner.example.test/wake", "bearer")).toEqual({ route: "none", reason: "insecure_bearer_webhook" });
    expect(route("https://runner.example.test/wake", "bearer")).toEqual({ route: "push" });
    expect(route("http://127.0.0.1:9000/wake", "bearer")).toEqual({ route: "push" });
    expect(route("http://[::1]:9000/wake", "bearer")).toEqual({ route: "push" });
    expect(route("http://localhost:9000/wake", "bearer")).toEqual({ route: "push" });
    // HMAC never sends the key itself.
    expect(route("http://203.0.113.5:9000/wake", "hmac")).toEqual({ route: "push" });
  } finally {
    for (const key of keys) delete process.env[`${prefix}_${key}`];
  }
});

afterAll(() => { /* fixtures live in the per-run temp data dir */ });
