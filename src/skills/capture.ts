import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { db } from '../db/connection.ts';
import type { AuthContext } from '../auth/middleware.ts';
import { authorize, type Principal } from '../auth/policy.ts';
import { QoopiaError } from '../utils/errors.ts';
import { redactSensitive } from '../utils/secret-guard.ts';
import { canonical, command, digest } from './commands.ts';
import { contentSchema } from './format.ts';
import { reviseDraft, requireSkillRead } from './authority.ts';

export const captureSchema = z.object({
  kind: z.enum(['manual', 'session', 'artifact', 'native', 'run']), locale: z.enum(['ru', 'en']).default('en'),
  title: z.string().min(1).max(300), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  text: z.string().max(100_000).optional(), source_id: z.string().max(200).optional(),
  first_message_id: z.number().int().positive().optional(), last_message_id: z.number().int().positive().optional(),
  filename: z.string().max(400).optional(), metadata: z.record(z.string().max(1000)).default({}),
  content: contentSchema.optional(), choice: z.enum(['new','update','fork']).default('new'),
  draft_id: z.string().max(200).optional(), skill_id:z.string().max(200).optional(), parent_skill_id: z.string().max(200).optional(),
  expected_revision: z.number().int().nonnegative(), idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();

function sourceText(database: Database, p: Principal, a: z.infer<typeof captureSchema>): string {
  if (a.kind === 'manual' || a.kind === 'native') {
    if (!a.text?.trim()) throw new QoopiaError('INVALID_INPUT', 'Select a nonempty procedure');
    if (a.kind === 'native' && !/^---\r?\n[\s\S]*?\bname:\s*[^\n]+[\s\S]*?\bdescription:\s*[^\n]+[\s\S]*?\r?\n---/m.test(a.text)) {
      throw new QoopiaError('UNSUPPORTED', 'Native capture requires SKILL.md with name and description');
    }
    return a.text;
  }
  if (!a.source_id) throw new QoopiaError('INVALID_INPUT', 'Select a source');
  if (a.kind === 'session') {
    if (!a.first_message_id || !a.last_message_id || a.last_message_id < a.first_message_id) throw new QoopiaError('INVALID_INPUT', 'Select an exact message range');
    const session = database.query(`SELECT 1 FROM sessions WHERE id=? AND workspace_id=? AND (agent_id=? OR EXISTS(SELECT 1 FROM workspace_owners WHERE workspace_id=? AND actor_id=?))`)
      .get(a.source_id, p.workspace_id, p.id, p.workspace_id, p.id);
    if (!session) throw new QoopiaError('NOT_FOUND', 'Source session not found');
    const rows = database.query('SELECT id,content FROM session_messages WHERE session_id=? AND workspace_id=? AND id BETWEEN ? AND ? ORDER BY id')
      .all(a.source_id, p.workspace_id, a.first_message_id, a.last_message_id) as { id: number; content: string }[];
    if (rows[0]?.id !== a.first_message_id || rows.at(-1)?.id !== a.last_message_id) throw new QoopiaError('NOT_FOUND', 'Source range is incomplete');
    return rows.map(r => r.content).join('\n');
  }
  if (a.kind === 'artifact') {
    const f = database.query('SELECT filename,text_excerpt,content FROM files WHERE id=? AND workspace_id=?').get(a.source_id, p.workspace_id) as { filename: string; text_excerpt: string | null; content: Uint8Array } | null;
    if (!f) throw new QoopiaError('NOT_FOUND', 'Artifact not found');
    if (!f.text_excerpt) throw new QoopiaError('UNSUPPORTED', 'Artifact has no extracted text; keep the original and correct extraction first');
    return f.filename + '\n' + f.text_excerpt;
  }
  const run = database.query('SELECT r.objective,r.version_id,v.skill_id FROM skill_runs r JOIN skill_versions v ON v.id=r.version_id WHERE r.id=? AND r.workspace_id=?')
    .get(a.source_id, p.workspace_id) as { objective: string; skill_id: string } | null;
  if (!run) throw new QoopiaError('NOT_FOUND', 'Run not found');
  requireSkillRead(database, p, run.skill_id);
  const outcomes = database.query('SELECT status,assertions_json FROM skill_outcomes WHERE run_id=? ORDER BY created_at_ms,id').all(a.source_id);
  return canonical({ objective: run.objective, outcomes });
}

export function captureSkill(auth: AuthContext, input: unknown, database: Database = db) {
  const a = captureSchema.parse(input), p = authorize(database, auth, 'draft');
  const source = sourceText(database, p, a);
  if (source.length > 100_000) throw new QoopiaError('SIZE_LIMIT', 'Select a smaller source span');
  const findings: string[] = [];
  const clean = (value: string, field: string) => {
    const r = redactSensitive(value); findings.push(...r.categories.map(c => `${field}:${c}`)); return r.text;
  };
  const text = clean(source, 'source'), title = clean(a.title, 'title');
  clean(a.filename ?? '', 'filename');
  for (const [k, v] of Object.entries(a.metadata)) { clean(k, 'metadata-key'); clean(v, 'metadata-value'); }
  const structured = a.content ? JSON.parse(clean(canonical(a.content), 'content')) : null;
  const sourceDigest = digest(canonical({ text, title, content: structured, locale: a.locale, choice:a.choice, target:a.draft_id??a.skill_id??a.parent_skill_id??a.slug }));
  return command(database, auth, 'draft', 'skill_capture', a.idempotency_key,
    JSON.parse(JSON.stringify({ ...a, title, text: undefined, content: structured, metadata: {}, filename: undefined, source_digest: sourceDigest })), a.slug,
    current => { sourceText(database, current, a); }, ({ now, principal }) => {
      const prior = database.query('SELECT draft_id,outcome FROM skill_captures WHERE workspace_id=? AND actor_id=? AND source_kind=? AND source_digest=?')
        .get(principal.workspace_id, principal.id, a.kind, sourceDigest) as { draft_id: string | null; outcome: string } | null;
      if (prior) {
        const draft=prior.draft_id?database.query('SELECT skill_id,revision FROM skill_drafts WHERE id=?').get(prior.draft_id) as {skill_id:string;revision:number}:null;
        return { data: { ...prior, skill_id:draft?.skill_id??null, reused: true, findings }, revision:draft?.revision??0 };
      }
      const steps = text.split('\n').filter(line => /^\s*(?:\d+[.)]|[-*])\s+/.test(line)).map(line => line.replace(/^\s*(?:\d+[.)]|[-*])\s+/, ''));
      const oneOff = /\b(?:one[- ]off|only once)\b|одноразов|только один раз/i.test(text);
      const reusable = !oneOff && (structured?.procedure.length >= 2 || steps.length >= 2);
      let draftId: string | null = null;
      let result: Record<string, unknown> = { outcome: 'refused', alternative: 'memory_or_rule', reason: 'Select repeatable steps with explicit inputs and verification', findings };
      if (reusable) {
        const content = contentSchema.parse(structured ?? { title, purpose: '', procedure: steps, redaction_report: findings });
        content.title = title; content.redaction_report = [...new Set([...content.redaction_report, ...findings])];
        if (a.choice === 'update' && !a.draft_id) throw new QoopiaError('INVALID_INPUT', 'Update requires an existing draft');
        if (a.choice === 'fork' && !a.parent_skill_id) throw new QoopiaError('INVALID_INPUT', 'Fork requires an existing skill');
        const revision = reviseDraft(auth, { slug: a.slug, ...(a.skill_id?{skill_id:a.skill_id}:{}), ...(a.choice === 'update' ? {draft_id:a.draft_id} : {}),
          ...(a.choice === 'fork' ? {parent_skill_id:a.parent_skill_id} : {}), expected_revision: a.expected_revision,
          content, idempotency_key: `capture-${digest(a.idempotency_key)}` }, database);
        draftId = revision.data.draft_id;
        result = { ...revision.data, outcome: 'drafted', findings, content, skillability: 'editable_draft_not_verified' };
      }
      database.query(`INSERT INTO skill_captures(id,workspace_id,actor_id,origin_instance_id,created_at_ms,source_kind,source_digest,source_refs,redaction_report,draft_id,outcome)
        VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?,?,?,?)`)
        .run(randomUUID(), principal.workspace_id, principal.id, now, a.kind, sourceDigest,
          canonical({ source_id: a.source_id ?? null, first: a.first_message_id ?? null, last: a.last_message_id ?? null }), canonical(findings), draftId, reusable ? 'drafted' : 'refused');
      return { data: result, revision: reusable ? a.expected_revision + 1 : 0 };
    });
}
