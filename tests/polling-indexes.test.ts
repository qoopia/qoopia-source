import { expect, test } from 'bun:test';
import { db } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createWorkspace } from '../src/admin/workspaces.ts';
import { SESSION_MESSAGE_COUNT } from '../src/services/sessions.ts';
import { pruneDeliveredTransit } from '../src/services/retention.ts';

// Parameters as literals, and the statement finalized: an explained UPDATE otherwise stays open on the
// shared connection and blocks the next transaction's commit.
function plan(sql: string) {
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql.replaceAll('?', "'x'")}`);
  try { return (statement.all() as {detail:string}[]).map(row => row.detail).join(' | '); } finally { statement.finalize(); }
}

test('hot polling queries search an index instead of scanning a growing table [A1-06..A1-08, A1-10]', () => {
  runMigrations();
  // Telegram delivery, every second per owner (my-agent-telegram.ts, my-agent.ts).
  for (const sql of ["SELECT state,message_id FROM qoopia_telegram_outbox WHERE run_id=? AND generation=? AND delivery_key LIKE 'run:%'",
    "UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE run_id=? AND state='queued'",
    'UPDATE qoopia_telegram_inbox SET state=? WHERE run_id=?']) expect(plan(sql)).not.toContain('SCAN qoopia_telegram');
  // skill_get's last self-reported test (skills.ts) and operation_get's delivery state (api/authority.ts).
  expect(plan("SELECT details_json FROM authority_events WHERE workspace_id=? AND subject_id=? AND kind='skill_test_self_reported' ORDER BY event_seq DESC LIMIT 1"))
    .toContain('USING INDEX idx_authority_events_subject');
  expect(plan("SELECT state,attempt_count,last_error_code FROM memory_event_outbox WHERE workspace_id=? AND aggregate_kind='authority_command' AND aggregate_id=?"))
    .toContain('USING INDEX idx_memory_event_outbox_aggregate');
  // saveMessage's count reads the session's own index entries only.
  expect(plan(SESSION_MESSAGE_COUNT)).toContain('USING COVERING INDEX idx_session_messages_session');
  // The memory worker's live window reads only sessions active in it.
  expect(plan(`SELECT s.id FROM sessions s JOIN agents a ON a.id=s.agent_id AND a.active=1 WHERE a.memory_mode='auto' AND s.last_active>=?`))
    .toMatch(/USING INDEX idx_sessions_agent_active \(agent_id=\? AND last_active>\?\)/);
});

test('no table keeps two indexes on the same columns [A1-09]', () => {
  runMigrations();
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  const duplicates: string[] = [];
  for (const { name } of tables) {
    const seen = new Map<string, string>();
    for (const index of db.query(`PRAGMA index_list("${name}")`).all() as {name:string;partial:number}[]) {
      if (index.partial) continue;
      const columns = (db.query(`PRAGMA index_info("${index.name}")`).all() as {name:string}[]).map(c => c.name).join(',');
      if (seen.has(columns)) duplicates.push(`${name}: ${seen.get(columns)} = ${index.name}`); else seen.set(columns, index.name);
    }
  }
  expect(duplicates).toEqual([]);
});

test('maintenance removes month-old delivered transit and keeps anything still in flight [A1-07, A1-08]', () => {
  runMigrations();
  const ws = createWorkspace({ name: 'Transit retention' }), old = Date.now() - 40 * 86_400_000, recent = Date.now() - 86_400_000;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    const run = db.query("INSERT INTO qoopia_agent_runs(id,conversation_id,request_id,prompt,state,created_at,updated_at) VALUES(?,'c',?,'',?,?,?)");
    run.run('run-old', 'r1', 'completed', new Date(old).toISOString(), new Date(old).toISOString());
    run.run('run-new', 'r2', 'completed', new Date(recent).toISOString(), new Date(recent).toISOString());
    const inbox = db.query("INSERT INTO qoopia_telegram_inbox(owner_id,generation,update_id,prompt,state,run_id,created_at) VALUES('o','g',?,'',?,?,?)");
    inbox.run(1, 'done', 'run-old', old); inbox.run(2, 'queued', null, old); inbox.run(3, 'done', 'run-new', recent);
    const outbox = db.query("INSERT INTO qoopia_telegram_outbox(owner_id,generation,delivery_key,body,run_id,state) VALUES('o','g',?,'{}',?,?)");
    outbox.run('run:old:0', 'run-old', 'sent'); outbox.run('run:old:1', 'run-old', 'uncertain'); outbox.run('run:new:0', 'run-new', 'sent');
    const event = db.query(`INSERT INTO memory_event_outbox(id,workspace_id,event_type,aggregate_kind,aggregate_id,payload,state,idempotency_key,delivered_at)
      VALUES(?,?,'authority_command','authority_command',?,'{}',?,?,?)`);
    event.run('e-old', ws.id, 'a1', 'delivered', 'transit-old', new Date(old).toISOString());
    event.run('e-new', ws.id, 'a2', 'delivered', 'transit-new', new Date(recent).toISOString());
    event.run('e-pending', ws.id, 'a3', 'pending', 'transit-pending', null);
    expect(pruneDeliveredTransit()).toEqual({ telegram_inbox: 1, telegram_outbox: 1, memory_events: 1 });
    expect((db.query("SELECT update_id FROM qoopia_telegram_inbox WHERE owner_id='o' ORDER BY update_id").all() as {update_id:number}[]).map(r => r.update_id)).toEqual([2, 3]);
    expect((db.query("SELECT delivery_key FROM qoopia_telegram_outbox WHERE owner_id='o' ORDER BY delivery_key").all() as {delivery_key:string}[]).map(r => r.delivery_key)).toEqual(['run:new:0', 'run:old:1']);
    expect((db.query("SELECT id FROM memory_event_outbox WHERE workspace_id=? ORDER BY id").all(ws.id) as {id:string}[]).map(r => r.id)).toEqual(['e-new', 'e-pending']);
  } finally {
    db.exec("DELETE FROM qoopia_telegram_outbox WHERE owner_id='o'"); db.exec("DELETE FROM qoopia_telegram_inbox WHERE owner_id='o'");
    db.exec("DELETE FROM qoopia_agent_runs WHERE id IN ('run-old','run-new')");
    db.exec('PRAGMA foreign_keys=ON');
  }
});
