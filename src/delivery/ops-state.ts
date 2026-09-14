import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { durableWrite, privateDirectory, readJsonBytes, MAX_JSON_BYTES, JsonReadError, hash, preflightSpace } from './files.ts';
const alertSchema = z.object({
  id: z.string().uuid(), installation: z.string().min(1).max(200), component: z.literal('maintenance'),
  subject: z.literal('daily'), cause: z.string().regex(/^[A-Z_]{1,64}$/), active: z.boolean(),
  state: z.enum(['pending', 'confirmed']), attempts: z.number().int().nonnegative(),
  next_attempt_at: z.number(), last_error: z.string().regex(/^[A-Z_]{1,64}$/).nullable(),
  receipt: z.object({ event_id: z.string().uuid(), payload_sha256: z.string().regex(/^[a-f0-9]{64}$/), accepted: z.literal(true) }).strict().nullable(),
}).strict();
export const RECOVERY_DELIVERY_HOLD = 'RECOVERY_REPLAY_REQUIRES_OWNER' as const;
export const RECOVERY_WARNING = 'Newer delivery knowledge and pending intent may be lost. Unreadable or unavailable history was not merged. Restored pending notifications may already have been accepted and could replay.';
export const OPS_JOURNAL_FORMAT = 'qoopia-ops/3' as const;
// /1 without a hold and the pre-versioning /1+hold candidate are both supported.
// Normalize in memory only; reads never rewrite the original journal.
const receiptSchema = z.object({ installation: z.string().min(1).max(200), event_id: z.string().uuid(),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/), accepted: z.literal(true) }).strict();
const legacySchema = z.object({ format: z.enum(['qoopia-ops/1', 'qoopia-ops/2']), delivery_hold: z.literal(RECOVERY_DELIVERY_HOLD).optional(), last_run: z.object({ at: z.string().datetime(), ok: z.boolean(), cause: z.string().regex(/^[A-Z_]{1,64}$/).nullable() }).strict().nullable(), alerts: z.array(alertSchema) }).strict();
const schema = legacySchema.extend({format:z.literal(OPS_JOURNAL_FORMAT),receipts:z.array(receiptSchema).optional()});
export type OpsState = Omit<z.infer<typeof schema>, 'format'> & {format:'qoopia-ops/1'|'qoopia-ops/2'|typeof OPS_JOURNAL_FORMAT};
export type OpsReceipt = z.infer<typeof receiptSchema>;
export type OpsAlert = z.infer<typeof alertSchema>;
// Reuse the existing delivery batch size for the diagnostic preview, not history retention.
export const OPS_ALERT_BATCH_LIMIT = 20;
type OpsJournalCode = 'OPS_JOURNAL_IO' | 'OPS_JOURNAL_INVALID' | 'OPS_JOURNAL_UNSUPPORTED_VERSION' | 'OPS_JOURNAL_INSTANCE_MISMATCH' | 'OPS_JOURNAL_TOO_LARGE' | 'OPS_JOURNAL_UNSAFE' | 'OPS_JOURNAL_CHANGED';
export class OpsJournalError extends Error {
  constructor(readonly code: OpsJournalCode) { super(code); }
}
export function opsJournalError(error: unknown): OpsJournalError {
  if (error instanceof OpsJournalError) return error;
  if (error instanceof JsonReadError) return new OpsJournalError(error.code === 'JSON_TOO_LARGE' ? 'OPS_JOURNAL_TOO_LARGE' : error.code === 'JSON_CHANGED' ? 'OPS_JOURNAL_CHANGED' : 'OPS_JOURNAL_UNSAFE');
  return new OpsJournalError(typeof (error as NodeJS.ErrnoException)?.code === 'string' ? 'OPS_JOURNAL_IO' : 'OPS_JOURNAL_UNSAFE');
}
export const opsFile = (data: string) => path.join(data, 'operations-status.json');
function parseOps(value: unknown): OpsState {
  // Inspect the envelope before strict schema validation. Unknown versions, even
  // with unfamiliar/malformed bodies, are never candidates for corrupt recovery.
  if (value && typeof value === 'object' && 'format' in value && value.format !== 'qoopia-ops/1' && value.format !== 'qoopia-ops/2' && value.format !== OPS_JOURNAL_FORMAT) {
    throw new OpsJournalError('OPS_JOURNAL_UNSUPPORTED_VERSION');
  }
  try { const reader = (value as OpsState)?.format === OPS_JOURNAL_FORMAT ? schema : legacySchema; return {...reader.parse(value), format: OPS_JOURNAL_FORMAT}; }
  catch { throw new OpsJournalError('OPS_JOURNAL_INVALID'); }
}
export function readOps(data: string): OpsState {
  let bytes: Buffer;
  try { bytes = readJsonBytes(opsFile(data)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: OPS_JOURNAL_FORMAT, last_run: null, alerts: [] };
    throw opsJournalError(error);
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new OpsJournalError('OPS_JOURNAL_INVALID'); }
  const state = parseOps(value);
  return validateRecoveryOps(state, state.alerts[0]?.installation ?? state.receipts?.[0]?.installation ?? 'empty');
}
/** Count actual UTF-8 JSON members without allocating an oversized joined string. */
export function opsSerializedSize(state: OpsState): number {
  const envelope = {...state, alerts:[], ...(state.receipts ? {receipts:[]} : {})};
  let size = Buffer.byteLength(JSON.stringify(envelope));
  for (const records of [state.alerts, state.receipts ?? []]) {
    for (const record of records) size += Buffer.byteLength(JSON.stringify(record));
    size += Math.max(0, records.length - 1);
  }
  return size;
}
/** Only verified, resolved confirmations lose display/attempt details. IDs never expire. */
export function compactOps(input: OpsState): OpsState {
  const state = validateRecoveryOps(input, input.alerts[0]?.installation ?? input.receipts?.[0]?.installation ?? 'empty');
  const receipts = [...(state.receipts ?? [])], alerts: OpsAlert[] = [];
  for (const alert of state.alerts) {
    if (alert.state === 'confirmed' && !alert.active) receipts.push({installation:alert.installation, ...alert.receipt!});
    else alerts.push(alert);
  }
  return {...state, alerts, ...(receipts.length ? {receipts} : {})};
}
/** One bounded serializer for writes, backups, and restore unions. No disk changes on refusal. */
export function serializeOps(input: OpsState): string {
  const parsed = parseOps(input);
  let state = validateRecoveryOps(parsed, parsed.alerts[0]?.installation ?? parsed.receipts?.[0]?.installation ?? 'empty');
  if (opsSerializedSize(state) > MAX_JSON_BYTES) state = compactOps(state);
  if (opsSerializedSize(state) > MAX_JSON_BYTES) throw new OpsJournalError('OPS_JOURNAL_TOO_LARGE');
  return JSON.stringify(state);
}
export function writeOps(data: string, state: OpsState) {
  const bytes = serializeOps(state);
  preflightSpace(data, [Buffer.byteLength(bytes)]);
  privateDirectory(data); durableWrite(opsFile(data), bytes);
}
export function recordMaintenance(data: string, installation: string, cause: string | null, now = Date.now()) {
  // Owner-approved lossless compaction is attempted at the finite member ceiling.
  const state = readRecoveryOps(data, installation);
  state.last_run = { at: new Date(now).toISOString(), ok: cause === null, cause };
  for (const alert of state.alerts) if (alert.installation === installation && alert.cause !== cause) alert.active = false;
  if (cause && !state.alerts.some(a => a.installation === installation && a.cause === cause && a.active)) {
    state.alerts.push({ id: randomUUID(), installation, component: 'maintenance', subject: 'daily', cause,
      active: true, state: 'pending', attempts: 0, next_attempt_at: now, last_error: 'NO_CHANNEL', receipt: null });
  }
  writeOps(data, state); return readRecoveryOps(data, installation);
}
export function opsSummary(data: string, instance?: string) {
  try {
    const state = instance === undefined ? readOps(data) : readRecoveryOps(data, instance);
    let pending = 0, active = 0;
    for (const alert of state.alerts) { if (alert.state === 'pending') pending++; if (alert.active) active++; }
    const preview: OpsAlert[] = [];
    // Active first, then unresolved delivery, then history. Each pass stops at the shared bound.
    for (const priority of [0, 1, 2]) {
      for (let i = state.alerts.length - 1; i >= 0 && preview.length < OPS_ALERT_BATCH_LIMIT; i--) {
        const alert = state.alerts[i]!;
        if ((alert.active ? 0 : alert.state === 'pending' ? 1 : 2) === priority) preview.push(alert);
      }
    }
    return { status: state.delivery_hold ? 'degraded' : state.last_run ? (state.last_run.ok ? 'ok' : 'degraded') : 'unknown', last_run: state.last_run,
      ...(state.delivery_hold ? {delivery_hold:state.delivery_hold,warning:RECOVERY_WARNING} : {}),
      pending, active, compact_receipts: state.receipts?.length ?? 0, total_alerts: state.alerts.length + (state.receipts?.length ?? 0), omitted_alerts: state.alerts.length + (state.receipts?.length ?? 0) - preview.length,
      alerts: preview.map(({ id, component, subject, cause, active, state, attempts, last_error }) => ({ id, component, subject, cause, active, state, attempts, last_error })) };
  } catch (error) { return { status: 'degraded', error: opsJournalError(error).code, pending: null, active: null, total_alerts: null, omitted_alerts: null, alerts: [] }; }
}

/** The exact payload ordering is shared with the existing outbox receipt contract. */
export function opsPayload(alert: OpsAlert) {
  return { installation: alert.installation, component: alert.component, subject: alert.subject, cause: alert.cause };
}
export function validateRecoveryOps(value: unknown, instance: string): OpsState {
  try {
    const state = parseOps(value), ids = new Set<string>(), active = new Set<string>();
    if (state.last_run && state.last_run.ok !== (state.last_run.cause === null)) throw new Error();
    for (const alert of state.alerts) {
      if (alert.installation !== instance) throw new OpsJournalError('OPS_JOURNAL_INSTANCE_MISMATCH');
      if (ids.has(alert.id) || !Number.isSafeInteger(alert.attempts) || !Number.isSafeInteger(alert.next_attempt_at) || alert.next_attempt_at < 0) throw new Error();
      ids.add(alert.id);
      if (alert.active) { if (active.has(alert.cause)) throw new Error(); active.add(alert.cause); }
      if (alert.state === 'pending') { if (alert.receipt !== null) throw new Error(); }
      else {
        const digest = hash(JSON.stringify({ id: alert.id, event_type: 'operational_alert', payload: opsPayload(alert) }));
        if (alert.receipt?.event_id !== alert.id || alert.receipt.payload_sha256 !== digest || alert.last_error !== null || alert.attempts < 1) throw new Error();
      }
    }
    for (const receipt of state.receipts ?? []) {
      if (receipt.installation !== instance) throw new OpsJournalError('OPS_JOURNAL_INSTANCE_MISMATCH');
      if (ids.has(receipt.event_id)) throw new Error();
      ids.add(receipt.event_id);
    }
    return state;
  } catch (error) { if (error instanceof OpsJournalError) throw error; throw new OpsJournalError('OPS_JOURNAL_INVALID'); }
}
export function readRecoveryOps(data: string, instance: string) {
  return validateRecoveryOps(readOps(data), instance);
}
/** Retain all intent and receipts; a restore must never undo a known acceptance. */
export function mergeRecoveryOps(saved: OpsState, local: OpsState, instance: string): OpsState {
  // Each input and the union have the same serialized member bound.
  saved = validateRecoveryOps(saved, instance); local = validateRecoveryOps(local, instance);
  for (const input of [saved, local]) if (opsSerializedSize(input) > MAX_JSON_BYTES) throw new OpsJournalError('OPS_JOURNAL_TOO_LARGE');
  const receipts = new Map<string, OpsReceipt>();
  for (const receipt of [...(local.receipts ?? []), ...(saved.receipts ?? [])]) {
    const current = receipts.get(receipt.event_id);
    if (current && current.payload_sha256 !== receipt.payload_sha256) throw new Error('Backup operations event conflict');
    receipts.set(receipt.event_id, receipt);
  }
  const time = (state: OpsState) => state.last_run ? Date.parse(state.last_run.at) : -1;
  const [older, newer] = time(saved) > time(local) ? [local, saved] : [saved, local];
  const alerts = new Map<string, OpsAlert>();
  for (const [source, isOlder] of [[newer, false], [older, true]] as const) for (const a of source.alerts) {
    const receipt = receipts.get(a.id);
    if (receipt) {
      const digest = hash(JSON.stringify({id:a.id,event_type:'operational_alert',payload:opsPayload(a)}));
      if (digest !== receipt.payload_sha256) throw new Error('Backup operations event conflict');
      continue; // Known resolved acceptance dominates even an old active/pending copy.
    }
    const current = alerts.get(a.id);
    if (!current) { alerts.set(a.id, {...a, active:isOlder ? false : a.active}); continue; }
    if (JSON.stringify(opsPayload(current)) !== JSON.stringify(opsPayload(a))) throw new Error('Backup operations event conflict');
    if (a.state === 'confirmed') Object.assign(current, {state: a.state, receipt: a.receipt, last_error: null});
    current.attempts = Math.max(a.attempts, current.attempts);
    current.next_attempt_at = Math.max(a.next_attempt_at, current.next_attempt_at);
  }
  const merged = validateRecoveryOps({...newer, ...(saved.delivery_hold || local.delivery_hold ? {delivery_hold:RECOVERY_DELIVERY_HOLD} : {}), alerts: [...alerts.values()], ...(receipts.size ? {receipts:[...receipts.values()]} : {})}, instance);
  return validateRecoveryOps(JSON.parse(serializeOps(merged)), instance);
}
