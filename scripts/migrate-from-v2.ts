#!/usr/bin/env bun
/**
 * scripts/migrate-from-v2.ts
 *
 * Copies prod Qoopia V2 data into the already-installed V3 database.
 * Usage:
 *   bun run scripts/migrate-from-v2.ts --source ~/.openclaw/qoopia/data/qoopia.db
 *
 * Idempotent: re-runs are safe (ON CONFLICT DO NOTHING on every insert).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertSchemaCurrent } from "../src/db/migrate.ts";
import { db as v3, closeDb } from "../src/db/connection.ts";
import { env } from "../src/utils/env.ts";
import { safeJsonParse, nowIso } from "../src/utils/errors.ts";
import {
  assertDatabaseIntegrity,
  openReadonlyDatabase,
} from "../src/db/sqlite.ts";

const argv = process.argv.slice(2);
function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return argv[i + 1];
}

const SOURCE =
  arg("source") || path.join(os.homedir(), ".openclaw/qoopia/data/qoopia.db");

if (!fs.existsSync(SOURCE)) {
  console.error(`V2 database not found: ${SOURCE}`);
  process.exit(1);
}

// Schema application is a separate operator step with its own preflight and
// backup. Data import cannot mutate schema as a side effect.
assertSchemaCurrent("migrate-from-v2");

const v2 = openReadonlyDatabase(SOURCE);
// The legacy source may contain relationships this converter deliberately
// normalizes. The writable V3 target, however, must be clean before import.
assertDatabaseIntegrity(v3, "V3 migration target");

const report: Record<string, unknown> = {};
const warnings: string[] = [];
const startTime = Date.now();

function count(table: string, where = ""): number {
  try {
    const r = v2.prepare(`SELECT COUNT(*) as c FROM ${table} ${where}`).get() as
      | { c: number }
      | undefined;
    return r?.c ?? 0;
  } catch {
    return 0;
  }
}

function run() {
  v3.exec("BEGIN");
  try {
    migrateWorkspaces();
    migrateUsers();
    migrateAgents();
    // Projects FIRST so notes/tasks/deals/finances can reference them via FK
    migrateProjects();
    migrateNotes();
    migrateTasks();
    migrateDeals();
    migrateContacts();
    migrateFinances();
    migrateActivity();
    migrateOAuthClients();
    migrateOAuthTokens();
    migrateIdempotencyKeys();

    // Skip tables (explicitly dropped)
    report.activity_archive_skipped = count("activity_archive");
    report.magic_links_dropped = count("magic_links");
    report.oauth_codes_skipped = count("oauth_codes");
    report.webhook_dead_letters_dropped = count("webhook_dead_letters");

    v3.exec("COMMIT");
  } catch (err) {
    v3.exec("ROLLBACK");
    throw err;
  }

  // Post-commit: FTS rebuild + optimize
  try {
    v3.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);
  } catch (e) {
    warnings.push(`FTS rebuild: ${e}`);
  }
  try {
    v3.exec("ANALYZE");
  } catch {}
  // VACUUM must be outside a transaction and may fail if server is live
  try {
    v3.exec("VACUUM");
  } catch (e) {
    warnings.push(`VACUUM skipped: ${e}`);
  }
}

function migrateWorkspaces() {
  const rows = v2.prepare(`SELECT * FROM workspaces`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO workspaces (id, name, slug, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const w of rows) {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(w.settings || "{}");
      delete (settings as any).webhooks;
    } catch {}
    stmt.run(
      w.id,
      w.name,
      w.slug,
      JSON.stringify(settings),
      w.created_at,
      w.updated_at || w.created_at,
    );
  }
  report.workspaces = rows.length;
}

function migrateUsers() {
  const rows = v2.prepare(`SELECT * FROM users`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO users (id, workspace_id, name, email, role, api_key_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const u of rows) {
    stmt.run(
      u.id,
      u.workspace_id,
      u.name,
      u.email,
      u.role || "member",
      u.api_key_hash,
      u.created_at,
    );
  }
  report.users = rows.length;
}

function migrateAgents() {
  const rows = v2.prepare(`SELECT * FROM agents`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO agents (id, workspace_id, name, type, api_key_hash, active, last_seen, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const a of rows) {
    const meta = safeJsonParse<Record<string, unknown>>(a.metadata, {});
    const perms = safeJsonParse<Record<string, unknown>>(a.permissions, {});
    const newMeta = { ...meta, legacy_permissions: perms };
    const type = /claude/i.test(a.name) ? "claude-privileged" : "standard";
    stmt.run(
      a.id,
      a.workspace_id,
      a.name,
      type,
      a.api_key_hash,
      a.active ?? 1,
      a.last_seen,
      JSON.stringify(newMeta),
      a.created_at,
    );
  }
  report.agents = rows.length;
}

function migrateNotes() {
  const rows = v2.prepare(`SELECT * FROM notes`).all() as any[];
  const validAgents = new Set<string>(
    (v3.prepare(`SELECT id FROM agents`).all() as Array<{ id: string }>).map(
      (a) => a.id,
    ),
  );
  const validProjects = new Set<string>(
    (
      v3
        .prepare(`SELECT id FROM notes WHERE type = 'project'`)
        .all() as Array<{ id: string }>
    ).map((p) => p.id),
  );
  const stmt = v3.prepare(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'migration', '[]', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  let orphanAgent = 0;
  let orphanProject = 0;
  for (const n of rows) {
    const type = n.type || "memory";
    let agent_id: string | null = n.agent_id || null;
    if (agent_id && !validAgents.has(agent_id)) {
      agent_id = null;
      orphanAgent++;
    }
    let project_id: string | null = n.project_id || null;
    if (project_id && !validProjects.has(project_id)) {
      project_id = null;
      orphanProject++;
    }
    const metadata: Record<string, unknown> = {
      source: n.source || "migration",
      v2_agent_name: n.agent_name,
      v2_orphan_agent_id: n.agent_id && !validAgents.has(n.agent_id) ? n.agent_id : undefined,
      v2_orphan_project_id:
        n.project_id && !validProjects.has(n.project_id) ? n.project_id : undefined,
    };
    stmt.run(
      n.id,
      n.workspace_id,
      agent_id,
      type,
      n.text,
      JSON.stringify(metadata),
      project_id,
      n.created_at,
      n.created_at,
    );
  }
  report.notes_original = rows.length;
  if (orphanAgent) warnings.push(`notes: ${orphanAgent} orphan agent_id nulled`);
  if (orphanProject)
    warnings.push(`notes: ${orphanProject} orphan project_id nulled`);
}

function migrateTasks() {
  const rows = v2.prepare(`SELECT * FROM tasks`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'task', ?, ?, ?, 'migration', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const t of rows) {
    const text = t.description ? `${t.title}\n\n${t.description}` : t.title;
    const metadata = {
      status: t.status || "todo",
      priority: t.priority || "medium",
      assignee: t.assignee,
      due_date: t.due_date,
      blocked_by: safeJsonParse(t.blocked_by, []),
      parent_id: t.parent_id,
      attachments: safeJsonParse(t.attachments, []),
      tags: safeJsonParse(t.tags, []),
      inline_notes: t.notes,
      v2_revision: t.revision,
      v2_source: t.source,
      v2_updated_by: t.updated_by,
    };
    stmt.run(
      t.id,
      t.workspace_id,
      text,
      JSON.stringify(metadata),
      t.project_id,
      JSON.stringify(safeJsonParse(t.tags, [])),
      t.deleted_at,
      t.created_at,
      t.updated_at || t.created_at,
    );
  }
  report.tasks_migrated = rows.length;
}

function migrateDeals() {
  const rows = v2.prepare(`SELECT * FROM deals`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'deal', ?, ?, ?, 'migration', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  const dealContactsMap = new Map<string, Array<{ contact_id: string; role: string | null }>>();
  try {
    const jx = v2.prepare(`SELECT * FROM deal_contacts`).all() as any[];
    for (const dc of jx) {
      if (!dealContactsMap.has(dc.deal_id)) dealContactsMap.set(dc.deal_id, []);
      dealContactsMap.get(dc.deal_id)!.push({ contact_id: dc.contact_id, role: dc.role });
    }
  } catch {}

  for (const d of rows) {
    const metadata = {
      status: d.status,
      address: d.address,
      asking_price: d.asking_price,
      target_price: d.target_price,
      monthly_rent: d.monthly_rent,
      lease_term_months: d.lease_term_months,
      documents: safeJsonParse(d.documents, []),
      timeline: safeJsonParse(d.timeline, []),
      tags: safeJsonParse(d.tags, []),
      inline_notes: d.notes,
      contacts: dealContactsMap.get(d.id) || [],
      ...safeJsonParse<Record<string, unknown>>(d.metadata, {}),
      v2_revision: d.revision,
      v2_updated_by: d.updated_by,
    };
    stmt.run(
      d.id,
      d.workspace_id,
      d.name,
      JSON.stringify(metadata),
      d.project_id,
      JSON.stringify(safeJsonParse(d.tags, [])),
      d.deleted_at,
      d.created_at,
      d.updated_at || d.created_at,
    );
  }
  report.deals_migrated = rows.length;
}

function migrateContacts() {
  const rows = v2.prepare(`SELECT * FROM contacts`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'contact', ?, ?, NULL, 'migration', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  const cpMap = new Map<string, Array<{ project_id: string; role: string | null }>>();
  try {
    const jx = v2.prepare(`SELECT * FROM contact_projects`).all() as any[];
    for (const cp of jx) {
      if (!cpMap.has(cp.contact_id)) cpMap.set(cp.contact_id, []);
      cpMap.get(cp.contact_id)!.push({ project_id: cp.project_id, role: cp.role });
    }
  } catch {}

  for (const c of rows) {
    const metadata = {
      role: c.role,
      company: c.company,
      email: c.email,
      phone: c.phone,
      telegram_id: c.telegram_id,
      language: c.language || "EN",
      timezone: c.timezone,
      category: c.category,
      communication_rules: c.communication_rules,
      tags: safeJsonParse(c.tags, []),
      inline_notes: c.notes,
      projects: cpMap.get(c.id) || [],
      v2_revision: c.revision,
      v2_updated_by: c.updated_by,
    };
    stmt.run(
      c.id,
      c.workspace_id,
      c.name,
      JSON.stringify(metadata),
      JSON.stringify(safeJsonParse(c.tags, [])),
      c.deleted_at,
      c.created_at,
      c.updated_at || c.created_at,
    );
  }
  report.contacts_migrated = rows.length;
}

function migrateFinances() {
  const rows = v2.prepare(`SELECT * FROM finances`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'finance', ?, ?, ?, 'migration', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const f of rows) {
    const metadata = {
      finance_type: f.type,
      amount: f.amount,
      currency: f.currency || "USD",
      recurring: f.recurring || "none",
      status: f.status || "active",
      tags: safeJsonParse(f.tags, []),
      inline_notes: f.notes,
      v2_revision: f.revision,
      v2_updated_by: f.updated_by,
    };
    stmt.run(
      f.id,
      f.workspace_id,
      f.name,
      JSON.stringify(metadata),
      f.project_id,
      JSON.stringify(safeJsonParse(f.tags, [])),
      f.deleted_at,
      f.created_at,
      f.updated_at || f.created_at,
    );
  }
  report.finances_migrated = rows.length;
}

function migrateProjects() {
  const rows = v2.prepare(`SELECT * FROM projects`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'project', ?, ?, NULL, 'migration', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const p of rows) {
    const metadata = {
      description: p.description,
      status: p.status,
      owner_agent_id: p.owner_agent_id,
      color: p.color,
      tags: safeJsonParse(p.tags, []),
      settings: safeJsonParse(p.settings, {}),
      v2_revision: p.revision,
      v2_updated_by: p.updated_by,
    };
    stmt.run(
      p.id,
      p.workspace_id,
      p.name,
      JSON.stringify(metadata),
      JSON.stringify(safeJsonParse(p.tags, [])),
      p.deleted_at,
      p.created_at,
      p.updated_at || p.created_at,
    );
  }
  report.projects_migrated = rows.length;
}

function migrateActivity() {
  const rows = v2.prepare(`SELECT * FROM activity`).all() as any[];
  const validProjects = new Set<string>(
    (
      v3
        .prepare(`SELECT id FROM notes WHERE type = 'project'`)
        .all() as Array<{ id: string }>
    ).map((p) => p.id),
  );
  const stmt = v3.prepare(
    `INSERT INTO activity (id, workspace_id, agent_id, action, entity_type, entity_id, project_id, summary, details, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  let orphanProject = 0;
  for (const a of rows) {
    let project_id: string | null = a.project_id || null;
    if (project_id && !validProjects.has(project_id)) {
      project_id = null;
      orphanProject++;
    }
    stmt.run(
      a.id,
      a.workspace_id,
      a.action,
      a.entity_type,
      a.entity_id,
      project_id,
      a.summary,
      a.details || "{}",
      a.timestamp,
    );
  }
  report.activity_migrated = rows.length;
  if (orphanProject)
    warnings.push(`activity: ${orphanProject} orphan project_id nulled`);
}

function migrateOAuthClients() {
  const rows = v2.prepare(`SELECT * FROM oauth_clients`).all() as any[];
  const stmt = v3.prepare(
    `INSERT INTO oauth_clients (id, name, agent_id, client_secret_hash, redirect_uris, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const c of rows) {
    stmt.run(
      c.id,
      c.name,
      c.agent_id,
      c.client_secret_hash,
      c.redirect_uris || "[]",
      c.created_at,
    );
  }
  report.oauth_clients_migrated = rows.length;
}

function migrateOAuthTokens() {
  const now = nowIso();
  const rows = v2
    .prepare(`SELECT * FROM oauth_tokens WHERE revoked = 0 AND expires_at > ?`)
    .all(now) as any[];
  const stmt = v3.prepare(
    `INSERT INTO oauth_tokens
       (token_hash, client_id, agent_id, workspace_id, token_type, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(token_hash) DO NOTHING`,
  );
  for (const t of rows) {
    // V2 uses 'refresh_token' / 'access_token' strings; V3 uses 'refresh' / 'access' enum.
    let tt = (t.token_type || "refresh").toString();
    if (tt === "refresh_token") tt = "refresh";
    else if (tt === "access_token") tt = "access";
    if (tt !== "refresh" && tt !== "access") continue;
    stmt.run(
      t.token_hash,
      t.client_id,
      t.agent_id,
      t.workspace_id,
      tt,
      t.expires_at,
      t.created_at,
    );
  }
  report.oauth_tokens_migrated = rows.length;
}

function migrateIdempotencyKeys() {
  const now = nowIso();
  const rows = v2
    .prepare(`SELECT * FROM idempotency_keys WHERE expires_at > ?`)
    .all(now) as any[];
  // V2 has no workspace_id — fallback to first workspace
  const ws = v3.prepare(`SELECT id FROM workspaces LIMIT 1`).get() as
    | { id: string }
    | undefined;
  if (!ws) {
    report.idempotency_keys_migrated = 0;
    return;
  }
  const stmt = v3.prepare(
    `INSERT INTO idempotency_keys (key_hash, workspace_id, response, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key_hash) DO NOTHING`,
  );
  for (const k of rows) {
    stmt.run(k.key_hash, ws.id, k.response, k.created_at, k.expires_at);
  }
  report.idempotency_keys_migrated = rows.length;
}

// --- Main ---

try {
  run();
  const duration = Date.now() - startTime;
  const out = {
    timestamp: nowIso(),
    source: SOURCE,
    target: env.DATA_DIR,
    duration_ms: duration,
    counts: report,
    warnings,
  };
  fs.mkdirSync(env.LOG_DIR, { recursive: true });
  const logFile = path.join(env.LOG_DIR, `migration-${Date.now()}.log.json`);
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2));
  console.log("Migration complete:");
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error("Migration FAILED:", err);
  process.exit(1);
} finally {
  v2.close();
  closeDb();
}
