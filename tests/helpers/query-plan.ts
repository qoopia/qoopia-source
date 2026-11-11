import type { Database } from "bun:sqlite";

/**
 * The plan SQLite chooses for a query, one line per step.
 *
 * In Bun 1.3 an EXPLAIN statement stays "in progress" on its connection until it is finalized, whatever read it
 * (all, get, values). A cached one (db.query) therefore blocks the next DROP or COMMIT on the shared test database
 * until it happens to be collected: tool-profile.test.ts failed in CI with «database table is locked» whenever it
 * ran soon after a plan test.
 */
export function queryPlan(db: Database, sql: string, ...params: unknown[]): string[] {
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return (statement.all(...(params as never[])) as Array<{ detail: string }>).map((row) => row.detail);
  } finally {
    statement.finalize();
  }
}
