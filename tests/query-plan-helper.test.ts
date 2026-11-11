import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { queryPlan } from "./helpers/query-plan.ts";

test("reading a query plan leaves the shared connection free for the next DROP", () => {
  runMigrations();
  expect(queryPlan(db, "SELECT id FROM notes WHERE workspace_id = ?", "w").length).toBeGreaterThan(0);
  db.run("CREATE TABLE zz_query_plan_probe(x)");
  db.run("DROP TABLE zz_query_plan_probe"); // «database table is locked» while any statement is still in progress
});

test("every test that runs EXPLAIN finalizes its statement", () => {
  const offenders = fs.readdirSync(import.meta.dir).filter((name) => name.endsWith(".test.ts")).filter((name) => {
    const source = fs.readFileSync(path.join(import.meta.dir, name), "utf8");
    return /\.(query|prepare)\(\s*`EXPLAIN/.test(source) && !source.includes(".finalize()");
  });
  expect(offenders).toEqual([]);
});
