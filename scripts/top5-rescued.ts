#!/usr/bin/env bun
import { assertSchemaCurrent } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { recall } from "../src/services/recall.ts";

const QUERIES = ["крашнулся", "упал", "починили", "сломалась", "postmortem"];

async function main() {
  assertSchemaCurrent("top5 rescued report");
  const wsId = process.argv[2] || '01KMKRVYF2FN68D9N3C8BEGAHS';
  const ws = db.prepare(`SELECT id FROM workspaces WHERE id=? LIMIT 1`).get(wsId) as any;
  const ag = db.prepare(`SELECT id FROM agents WHERE workspace_id=? AND active=1 ORDER BY created_at ASC LIMIT 1`).get(ws.id) as any;
  for (const q of QUERIES) {
    const r = await recall({
      workspace_id: ws.id, caller_agent_id: ag.id, is_admin: true,
      query: q, scope: "notes", limit: 5, mode: "hybrid",
    });
    console.log(`\n=== "${q}" — ${r.results.length} hits, mode=${r.mode} ===`);
    r.results.slice(0, 5).forEach((row: any, i: number) => {
      const t = (row.text || "").replace(/\s+/g, " ").slice(0, 160);
      console.log(`${i+1}. [${row.type}] ${t}`);
    });
  }
}
main();
