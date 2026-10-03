/**
 * F-088: a private entity page (authority_private=1, from Skillonomia or native-draft
 * imports) is visible only to its authority owner and the workspace owner, on every
 * dashboard read: /entities (items, ?q= search, type_breakdown), /skills and the
 * /overview entity and skill counts. Stewards are not exempt.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server;
let baseUrl = "";
let OWNER_KEY = "";
let STEWARD_KEY = "";
let STANDARD_KEY = "";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Private pages", slug: "f088-private-pages" });
  const owner = bootstrapOwner(db, "F088 owner", undefined, ws.id);
  OWNER_KEY = owner.api_key;
  STEWARD_KEY = createAgent({ name: "f088-steward", workspaceSlug: ws.slug, type: "steward" }).api_key;
  STANDARD_KEY = createAgent({ name: "f088-standard", workspaceSlug: ws.slug }).api_key;
  const insert = db.query(`INSERT INTO entity_pages(id,workspace_id,type,slug,title,summary,authority_private,authority_owner_id)
    VALUES (?,?,'skill',?,?,?,?,?)`);
  insert.run("f088-public", ws.id, "f088-public", "Public skill", "shared summary", 0, null);
  insert.run("f088-private", ws.id, "f088-private", "PRIVATE F088 TITLE", "zebraword private summary", 1, owner.agent_id);
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string, key: string) {
  const r = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });
  expect(r.status).toBe(200);
  return r.json() as Promise<any>;
}
const ids = (body: { items: Array<{ id: string }> }) => body.items.map((item) => item.id);
const skillCount = (breakdown: Array<{ type: string; c: number }>) => breakdown.find((row) => row.type === "skill")?.c;

describe("F-088: private entity pages on dashboard reads", () => {
  for (const [who, key] of [["standard", () => STANDARD_KEY], ["steward", () => STEWARD_KEY]] as const) {
    test(`${who}: /entities, ?q=, type_breakdown, /skills and /overview exclude the private page`, async () => {
      const entities = await get("/api/dashboard/entities?type=skill", key());
      expect(ids(entities)).toEqual(["f088-public"]);
      expect(skillCount(entities.type_breakdown)).toBe(1);
      expect(ids(await get("/api/dashboard/entities?q=zebraword", key()))).toEqual([]);
      expect(ids(await get("/api/dashboard/skills", key()))).toEqual(["f088-public"]);
      const overview = await get("/api/dashboard/overview", key());
      expect(overview.entities).not.toBeNull();
      expect(overview.entities.total).toBe(1);
      expect(skillCount(overview.entities.by_type)).toBe(1);
      expect(overview.skills).not.toBeNull();
      expect(overview.skills.total).toBe(1);
    });
  }

  test("the workspace owner still sees the private page everywhere", async () => {
    const entities = await get("/api/dashboard/entities?type=skill", OWNER_KEY);
    expect(ids(entities).sort()).toEqual(["f088-private", "f088-public"]);
    expect(skillCount(entities.type_breakdown)).toBe(2);
    expect(ids(await get("/api/dashboard/entities?q=zebraword", OWNER_KEY))).toEqual(["f088-private"]);
    expect(ids(await get("/api/dashboard/skills", OWNER_KEY)).sort()).toEqual(["f088-private", "f088-public"]);
    const overview = await get("/api/dashboard/overview", OWNER_KEY);
    expect(overview.entities.total).toBe(2);
    expect(overview.skills.total).toBe(2);
  });
});
