import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { AuthContext } from '../auth/middleware.ts';
import { authorize, currentToolAuth, requireAgent } from '../auth/policy.ts';
import { localOwner } from '../delivery/owner-onboarding.ts';
import { readCurrent } from '../delivery/operations.ts';
import { safePath, readJsonBytes, privateDirectory, durableWrite, hash } from '../delivery/files.ts';

const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().max(4096).refine(value=>value.startsWith('/')&&value.length>1&&[...value].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127));
export const connectionRefSchema = z.object({ path: absolute, sha256: sha, instance: id,
  workspace_id: id, runtime_id: id, agent_id: id }).strict();
export type ConnectionRef = z.infer<typeof connectionRefSchema>;
const receiptSchema = z.object({ format: z.literal('qoopia-native-connection/1'),
  installation: z.object({ root: absolute, instance: id, bundle: sha, generation: id, port: z.number().int().min(1).max(65535) }).strict(),
  runtime_kind: z.enum(['codex', 'claude_code']), runtime_id: id, workspace_id: id, agent_id: id,
  agent_epoch: z.number().int(), agent_session: z.number().int(), owner_id: id, owner_epoch: z.number().int(), owner_session: z.number().int(),
  config: z.object({ path: absolute, dev: z.number(), ino: z.number(), sha256: sha }).strict(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;

function privateFile(file: string) {
  if (safePath(file) !== file) throw new Error('Connection path must be canonical');
  const parent = fs.lstatSync(path.dirname(file)), stat = fs.lstatSync(file);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) ||
      !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Connection requires private owned file and parent');
  return stat;
}
function readPrivate(file: string) {
  const before = privateFile(file), bytes = readJsonBytes(file), after = privateFile(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new Error('Connection file changed during read');
  return { bytes, identity: { path: file, dev: after.dev, ino: after.ino, sha256: hash(bytes) } };
}

/** Called only by connect after publishing the scoped file under the installation lock. No bearer in this receipt. */
export function publishNativeConnection(database: Database, input: Omit<Receipt, 'format' | 'config'> & { config: string }): ConnectionRef {
  const receipt = receiptSchema.parse({ ...input, format: 'qoopia-native-connection/1', config: readPrivate(input.config).identity });
  const folder = privateDirectory(path.join(input.installation.root, 'connections'));
  const file = path.join(folder, input.agent_id + '.json');
  if (!/^[a-f0-9-]{36}$/.test(input.agent_id) || fs.existsSync(file)) throw new Error('Fresh connection receipt required');
  const instance = database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as { instance_id: string };
  if (instance.instance_id !== input.installation.instance) throw new Error('Connection instance mismatch');
  const bytes = JSON.stringify(receipt);
  durableWrite(file, bytes);
  return { path: file, sha256: hash(bytes), instance: instance.instance_id, workspace_id: input.workspace_id,
    runtime_id: input.runtime_id, agent_id: input.agent_id };
}

// An opaque, process-local capability: callers cannot construct a credential-bearing binding from JSON.
export type BoundConnection = { readonly reference: ConnectionRef; readonly endpoint: string };
const secrets = new WeakMap<BoundConnection, { bearer: string; receipt: Receipt }>();
export const nativeMcpTools = ['qoopia_capabilities', 'note_create', 'note_get', 'recall'] as const;

/** Local adapter only. Remote authorize/observe handlers never open a client-supplied path. */
export function bindNativeConnection(database: Database, raw: unknown,
  expected: { runtime_id: string; runtime_kind: 'codex' | 'claude_code'; workspace_id: string }): BoundConnection {
  return bindConnection(database,raw,expected,false);
}
function bindConnection(database: Database, raw: unknown,
  expected: { runtime_id: string; runtime_kind: 'codex' | 'claude_code'; workspace_id: string }, refresh:boolean, reapprovingOwner?:AuthContext): BoundConnection {
  try {
    const reference = connectionRefSchema.parse(raw), read = readPrivate(reference.path);
    if (read.identity.sha256 !== reference.sha256) throw new Error();
    const receipt = receiptSchema.parse(JSON.parse(read.bytes.toString('utf8'))), c = receipt.installation;
    if (reference.path !== path.join(c.root, 'connections', receipt.agent_id + '.json') ||
        reference.instance !== c.instance || reference.runtime_id !== receipt.runtime_id || reference.agent_id !== receipt.agent_id ||
        reference.workspace_id !== receipt.workspace_id || expected.runtime_id !== receipt.runtime_id ||
        expected.workspace_id !== receipt.workspace_id || expected.runtime_kind !== receipt.runtime_kind) throw new Error();
    const current = readCurrent(c.root);
    if (current.instance !== c.instance || current.port !== c.port || (!refresh&&(current.bundle !== c.bundle || current.generation !== c.generation))) throw new Error();
    const instance = database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as { instance_id: string };
    if (instance.instance_id !== c.instance) throw new Error();
    const owner = localOwner(database, receipt.owner_id);
    if(refresh){
      if(reapprovingOwner?.agent_id!==receipt.owner_id)throw new Error();
      authorize(database,reapprovingOwner,'owner');
    }
    authorize(database, { ...owner, policy_epoch: receipt.owner_epoch, session_version: refresh?reapprovingOwner!.session_version:receipt.owner_session }, 'owner');
    const target = requireAgent(database, receipt.workspace_id, receipt.agent_id);
    if (target.principal_kind !== 'agent' || target.authority_profile !== 'memory-worker' || target.tool_profile !== 'no-destructive' ||
        target.policy_epoch !== receipt.agent_epoch || target.session_version !== receipt.agent_session) throw new Error();
    const registration = database.query('SELECT target_agent_id FROM runtime_registrations WHERE id=? AND workspace_id=?')
      .get(receipt.runtime_id, receipt.workspace_id) as { target_agent_id: string } | null;
    if (registration?.target_agent_id !== target.id) throw new Error();
    currentToolAuth(database, { agent_id: target.id, workspace_id: target.workspace_id, agent_name: target.name,
      type: target.type, source: 'api-key', policy_epoch: target.policy_epoch, session_version: target.session_version }, 'write-low');
    const config = readPrivate(receipt.config.path);
    if (JSON.stringify(config.identity) !== JSON.stringify(receipt.config)) throw new Error();
    const parsed = receipt.runtime_kind === 'codex' ? Bun.TOML.parse(config.bytes.toString('utf8')) : JSON.parse(config.bytes.toString('utf8'));
    const endpoint = `http://127.0.0.1:${c.port}/mcp`;
    const entry = receipt.runtime_kind === 'codex'
      ? z.object({ url: z.literal(endpoint), http_headers: z.object({ Authorization: z.string().regex(/^Bearer q_[A-Za-z0-9_-]{43}$/) }).strict() }).strict().parse(parsed.mcp_servers?.qoopia)
      : z.object({ type: z.literal('http'), url: z.literal(endpoint), headers: z.object({ Authorization: z.string().regex(/^Bearer q_[A-Za-z0-9_-]{43}$/) }).strict() }).strict().parse(parsed.mcpServers?.qoopia);
    const bearer = 'http_headers' in entry ? entry.http_headers.Authorization : entry.headers.Authorization;
    const key = database.query('SELECT 1 FROM agents WHERE id=? AND api_key_hash=? AND active=1').get(target.id, hash(bearer.slice(7)));
    if (!key) throw new Error();
    const bound = Object.freeze({ reference: Object.freeze(reference), endpoint });
    secrets.set(bound, { bearer, receipt });
    return bound;
  } catch { throw new Error('Native connection changed, unsafe, foreign, revoked or not connect-published'); }
}

/** Explicit current-owner reconnect after update or browser logout. Policy epochs, agent credentials, file bytes and instance must still match. */
export function refreshNativeConnection(database:Database,raw:unknown,
  expected:{runtime_id:string;runtime_kind:'codex'|'claude_code';workspace_id:string},owner:AuthContext):ConnectionRef {
  const bound=bindConnection(database,raw,expected,true,owner),value=secrets.get(bound)!;
  const current=readCurrent(value.receipt.installation.root);
  const receipt={...value.receipt,owner_session:owner.session_version,installation:{...value.receipt.installation,bundle:current.bundle,generation:current.generation}};
  const bytes=JSON.stringify(receipt);
  if(hash(bytes)===bound.reference.sha256)return bound.reference;
  durableWrite(bound.reference.path,bytes);
  const ref={...bound.reference,sha256:hash(bytes)};
  return bindNativeConnection(database,ref,expected).reference;
}

export function connectionLaunch(bound: BoundConnection | undefined, reference: ConnectionRef, kind: 'codex' | 'claude_code', home: string) {
  const value = bound && secrets.get(bound);
  if (!value || !bound || JSON.stringify(bound.reference) !== JSON.stringify(reference) || value.receipt.runtime_kind !== kind)
    throw new Error('Native launch requires a validated connection');
  // Only Qoopia is projected, even when connect preserved unrelated entries in the original config.
  return { bearer: value.bearer, endpoint: bound.endpoint, file: path.join(home, 'qoopia-mcp.json'),
    bytes: JSON.stringify({ mcpServers: { qoopia: { type: 'http', url: bound.endpoint, headers: { Authorization: value.bearer } } } }) };
}
