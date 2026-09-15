import fs from 'node:fs';
import { z } from 'zod';
import { safePath, readJson } from '../utils/fs.ts';
import { deliverMemoryEvent, type OutboxDestination } from './event-outbox.ts';
import { readOps, writeOps, opsPayload, OPS_ALERT_BATCH_LIMIT } from '../delivery/ops-state.ts';
// Shared outbox transport keeps HTTPS allowlisting, DNS pinning, no redirect, size/time bounds.
// Channels are supplied only by an explicit owner integration; empty defaults retain pending.
async function attemptOpsAlerts(data: string, channels: OutboxDestination[] = [], transport: Pick<Parameters<typeof deliverMemoryEvent>[0], 'fetchImpl' | 'resolver'> = {}, now = Date.now()) {
  const state = readOps(data);
  if (state.delivery_hold) return state;
  for (const alert of state.alerts.filter(a => a.state === 'pending' && a.next_attempt_at <= now).slice(0, OPS_ALERT_BATCH_LIMIT)) {
    if (!channels.length) continue;
    alert.attempts++;
    alert.next_attempt_at = now + Math.min(86400000, 1000 * 2 ** Math.min(alert.attempts, 16));
    alert.last_error = 'ACCEPTANCE_UNCONFIRMED';
    // Persist the attempt before IO; ambiguous/crashed requests remain retryable, same event ID.
    const beforeIO = readOps(data);
    if (beforeIO.delivery_hold) return beforeIO;
    const pending = beforeIO.alerts.find(a => a.id === alert.id);
    if (!pending || pending.state !== 'pending') continue;
    Object.assign(pending, {attempts:alert.attempts,next_attempt_at:alert.next_attempt_at,last_error:alert.last_error});
    writeOps(data, beforeIO);
    for (const destination of channels.slice(0, 2)) {
      try {
        const result = await deliverMemoryEvent({ row: { id: alert.id, event_type: 'operational_alert',
          payload: JSON.stringify(opsPayload(alert)) },
          destination, requireReceipt: true, ...transport });
        if (!result.receipt) continue;
        alert.receipt = result.receipt; alert.state = 'confirmed'; alert.last_error = null; break;
      } catch { /* Untrusted response/error bytes never enter persisted diagnostics. */ }
    }
    const latest = readOps(data);
    const current = latest.alerts.find(a => a.id === alert.id);
    if (current) Object.assign(current, {state:alert.state,receipt:alert.receipt,last_error:alert.last_error,attempts:alert.attempts,next_attempt_at:alert.next_attempt_at});
    writeOps(data, latest);
  }
  return readOps(data);
}

/** Owner creates this optional private policy file; no default destination or channel provisioning. */
export function readOwnerAlertChannels(file?: string): OutboxDestination[] {
  if (!file || !fs.existsSync(file)) return [];
  safePath(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384) throw new Error('ALERT_POLICY_UNSAFE');
  const policy = z.object({ format: z.literal('qoopia-alert-channels/1'), channels: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), url: z.string().url(), allowed_hosts: z.array(z.string().min(1).max(253)).max(10),
    signing_key_base64url: z.string().regex(/^[a-zA-Z0-9_-]{43,86}$/),
  }).strict()).max(2) }).strict().parse(readJson(file));
  return policy.channels.map(({signing_key_base64url,...channel}) => {
    const signing_key=Buffer.from(signing_key_base64url,'base64url');
    if(signing_key.length<32)throw new Error('ALERT_POLICY_INVALID');
    return {...channel,signing_key};
  });
}

const delivering = new Set<string>();
export async function deliverOpsAlerts(...args: Parameters<typeof attemptOpsAlerts>) {
  const key=safePath(args[0]);
  if(delivering.has(key))return readOps(key);
  delivering.add(key);
  try{return await attemptOpsAlerts(...args);}finally{delivering.delete(key);}
}
