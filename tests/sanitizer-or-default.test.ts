/**
 * Sanitizer OR-default behaviour.
 *
 * Prior implementation joined terms with a space (FTS5 implicit AND), so a
 * multi-word query like "context loss cascade" only matched rows that
 * contained ALL three tokens — failing on morphology/synonym mismatches and
 * returning 0 hits for the vast majority of natural-language queries.
 *
 * After fix:
 *  - single-term: "term"*                (unchanged)
 *  - multi-term:  "a"* OR "b"* OR "c"*    (any-match)
 *  - explicit user-typed AND/OR/NOT/NEAR are still dropped (not honoured yet)
 *  - end-to-end: a row containing only ONE of the query terms is surfaced
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall, sanitizeFtsQuery } from "../src/services/recall.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "Sanitizer OR Default",
    slug: "sanitizer-or-default",
  });
  WORKSPACE_ID = ws.id;
  const a = createAgent({ name: "sanitizer-or-agent", workspaceSlug: ws.slug });
  AGENT_ID = a.id;
});

describe("sanitizeFtsQuery — shape of the FTS5 expression", () => {
  test("single term: prefix-match, no OR connector", async () => {
    expect(sanitizeFtsQuery("crash")).toBe('"crash"*');
  });

  test("multi term: each prefixed, joined with OR", async () => {
    expect(sanitizeFtsQuery("context loss cascade")).toBe(
      '"context"* OR "loss"* OR "cascade"*',
    );
  });

  test("user-typed boolean operators are stripped, OR-join still applied", async () => {
    // "сломал OR failover OR overload" → user thinks they're typing OR, but
    // the sanitizer drops the keywords and applies its own OR-join.
    expect(sanitizeFtsQuery("сломал OR failover OR overload")).toBe(
      '"сломал"* OR "failover"* OR "overload"*',
    );
  });

  test("punctuation that breaks FTS5 is stripped", async () => {
    expect(sanitizeFtsQuery('note "create" (body)')).toBe(
      '"note"* OR "create"* OR "body"*',
    );
  });

  test("empty / single-letter tokens dropped", async () => {
    expect(sanitizeFtsQuery("a sample")).toBe('"sample"*');
  });

  test("empty query throws INVALID_INPUT", async () => {
    expect(() => sanitizeFtsQuery("")).toThrow();
    expect(() => sanitizeFtsQuery("   ")).toThrow();
    expect(() => sanitizeFtsQuery("a")).toThrow(); // single letter → 0 usable
  });
});

describe("recall — multi-term OR-default end-to-end", () => {
  beforeAll(() => {
    // Three notes, each containing exactly ONE of the query terms.
    // Under the old AND-default, "alpha beta gamma" would match none.
    // Under OR-default, all three should surface.
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      type: "memory",
      text: "alpha-marker xenocanto-001 unique note A",
    });
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      type: "memory",
      text: "beta-marker xenocanto-002 unique note B",
    });
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      type: "memory",
      text: "gamma-marker xenocanto-003 unique note C",
    });
    // A control row that should NEVER match the query — proves OR isn't
    // over-broad (no token from query is present).
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      type: "memory",
      text: "delta-marker xenocanto-004 unrelated control row",
    });
  });

  test("3-term query surfaces all 3 rows that contain ANY term", async () => {
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "alpha-marker beta-marker gamma-marker",
      scope: "notes",
      limit: 10,
    });
    expect(r.results.length).toBe(3);
    const texts = r.results.map((x) => x.text).join("|");
    expect(texts).toContain("alpha-marker");
    expect(texts).toContain("beta-marker");
    expect(texts).toContain("gamma-marker");
    expect(texts).not.toContain("delta-marker");
  });

  test("sanitized_query is OR-joined as expected", async () => {
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "alpha-marker beta-marker",
      scope: "notes",
    });
    expect(r.sanitized_query).toBe('"alpha-marker"* OR "beta-marker"*');
  });

  test("ORDER BY rank: best-scoring row comes first", async () => {
    // A row that contains BOTH query terms should outrank rows with one.
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      type: "memory",
      text: "alpha-marker beta-marker double-hit row should rank first",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "alpha-marker beta-marker",
      scope: "notes",
      limit: 10,
    });
    expect(r.results.length).toBeGreaterThanOrEqual(3);
    expect(r.results[0]!.text).toContain("double-hit");
  });
});
