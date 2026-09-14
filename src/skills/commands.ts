import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../auth/middleware.ts";
import { authorize, type AuthorityAction, type Principal } from "../auth/policy.ts";
import { QoopiaError } from "../utils/errors.ts";
import { jcsCanonicalize, type JcsValue } from "./legacy/jcs.ts";

export function canonical(value: unknown): string { return jcsCanonicalize(value as JcsValue); }
export function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export interface CommandResult<T> { data: T; revision: number; request_id: string; operation_id: string; }
export interface CommandContext { id: string; now: number; principal: Principal; }

/** Callback is synchronous: domain changes, audit, outbox and replay commit together. */
export function command<T>(database: Database, auth: AuthContext, action: AuthorityAction, operation: string,
  key: string, body: unknown, subject: string, visibility: (p: Principal) => void,
  mutate: (context: CommandContext) => { data: T; revision: number },
): CommandResult<T> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new QoopiaError("INVALID_INPUT", "A 1–128 character idempotency key is required");
  const requestDigest = digest(canonical(body));
  return database.transaction(() => {
    const p = authorize(database, auth, action);
    visibility(p); // authorization and object scope ALWAYS precede replay
    const old = database.query(`SELECT request_digest,response_json FROM authority_commands
      WHERE workspace_id=? AND actor_id=? AND operation=? AND key_digest=?`)
      .get(p.workspace_id, p.id, operation, digest(key)) as { request_digest: string; response_json: string } | null;
    if (old) {
      if (old.request_digest !== requestDigest) throw new QoopiaError("IDEMPOTENCY_MISMATCH", "Key was committed with a different request body");
      return JSON.parse(old.response_json) as CommandResult<T>;
    }
    const now = Date.now();
    const count = database.query("SELECT count(*) AS n FROM authority_commands WHERE actor_id=? AND created_at_ms>?")
      .get(p.id, now - 60_000) as { n: number };
    if (count.n >= 120) throw new QoopiaError("RATE_LIMITED", "Principal mutation quota exceeded; retry after 60 seconds");
    const id = randomUUID();
    const result = mutate({ id, now, principal: p });
    const response = { ...result, request_id: id, operation_id: id };
    const responseJson = canonical(response);
    database.query(`INSERT INTO authority_commands
      (id,workspace_id,actor_id,origin_instance_id,created_at_ms,operation,key_digest,request_digest,subject_id,response_json)
      VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?,?,?)`).run(id, p.workspace_id, p.id, now, operation, digest(key), requestDigest, subject, responseJson);
    database.query(`INSERT INTO authority_events
      (id,workspace_id,actor_id,origin_instance_id,created_at_ms,command_id,kind,subject_id,details_json)
      VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?,?)`).run(randomUUID(), p.workspace_id, p.id, now, id, operation, subject, canonical({ revision: result.revision }));
    database.query(`INSERT INTO memory_event_outbox
      (id,workspace_id,event_type,aggregate_kind,aggregate_id,payload,idempotency_key,created_at,updated_at)
      VALUES (?,?,'authority_command','authority_command',?,?,?,?,?)`).run(
      randomUUID(), p.workspace_id, id, canonical({ operation_id: id, kind: operation }), `authority:${id}`,
      new Date(now).toISOString(), new Date(now).toISOString());
    // All transports serialize the same persisted representation on first use and replay.
    return JSON.parse(responseJson) as CommandResult<T>;
  }).immediate();
}
