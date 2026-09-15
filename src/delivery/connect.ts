import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db, DB_PATH } from '../db/connection.ts';
import { authenticate } from '../auth/middleware.ts';
import { authorize } from '../auth/policy.ts';
import { issuePairing, redeemPairing, revokePrincipal } from '../auth/pairings.ts';
import { createMcpServer } from '../mcp/server.ts';
import { localOwner } from './owner-onboarding.ts';
import { hash, readJsonBytes, safePath, durableWrite } from '../utils/fs.ts';
import { assertNoSecrets } from '../utils/secret-guard.ts';
import { publishNativeConnection } from '../skills/connection.ts';

export const connectInput = z.object({
  runtime: z.enum(['claude_code', 'codex']), name: z.string().trim().min(1).max(120),
  config: z.string().min(1), ownerId: z.string().min(1).optional(),
}).strict();
type Input = z.infer<typeof connectInput>;
type Context = { root: string; instance: string; bundle: string; generation: string; port: number };
const SAMPLE = 'Qoopia connection check (sample). This is a local memory check, not a completed user task.';

function configState(input: Input, root: string) {
  const file = safePath(input.config), parent = path.dirname(file);
  if (file === root || file.startsWith(root + path.sep)) throw new Error('Native config must be outside the installation');
  // Do not create or chmod native roots implicitly. The owner selects an existing private directory.
  const directory = fs.lstatSync(parent);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw new Error('Config parent must already be owned and private (0700)');
  let before: Buffer | null = null;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Existing config must be owned and private (0600)');
    before = readJsonBytes(file); // bounded bytes, also for TOML; no credential values are emitted
  }
  const text = before?.toString('utf8') ?? '';
  let parsed: Record<string, unknown>;
  try {
    parsed = input.runtime === 'codex' ? Bun.TOML.parse(text) : (before ? JSON.parse(text) : {});
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    const servers = parsed[input.runtime === 'codex' ? 'mcp_servers' : 'mcpServers'];
    if (servers !== undefined && (!servers || Array.isArray(servers) || typeof servers !== 'object')) throw new Error();
    if (servers && Object.hasOwn(servers, 'qoopia')) throw new Error();
  } catch { throw new Error('Config malformed or qoopia entry already exists; preserve it and choose an explicit new config'); }
  const beforeHash = before ? hash(before) : null;
  const backup = before ? file + '.qoopia-before-' + beforeHash : null;
  if (backup && fs.existsSync(backup)) throw new Error('Config preservation path already exists; inspect it before a new connection');
  return { file, before, parsed, text, beforeHash, backup };
}

/** Installed, stopped-server local OS operation. The caller holds lockInstallation for preview and apply. */
export async function connectInstalled(raw: unknown, context: Context, approval?: string) {
  const input = connectInput.parse(raw);
  assertNoSecrets(input.name, 'connect.name');
  const uid = process.getuid?.(), stat = fs.lstatSync(safePath(DB_PATH));
  if (uid === undefined || uid === 0 || process.geteuid?.() !== uid || stat.uid !== uid || (stat.mode & 0o077)) throw new Error('Connect requires the private database owner local OS session');
  const owner = localOwner(db, input.ownerId), principal = authorize(db, owner, 'owner');
  if (db.query('SELECT 1 FROM agents WHERE workspace_id=? AND name=?').get(owner.workspace_id, input.name)) throw new Error('Principal name already exists; connect never replaces an identity');
  const config = configState(input, context.root);
  const endpoint = `http://127.0.0.1:${context.port}/mcp`;
  const changes = {
    format: 'qoopia-connect-preview/1', installation: context, owner_id: owner.agent_id,
    workspace_id: owner.workspace_id, owner_epoch: principal.policy_epoch, owner_session: principal.session_version,
    name: input.name, runtime: input.runtime, profile: 'memory-worker', tool_profile: 'no-destructive',
    authority: 'Existing P1 workspace memory read/write-low and feedback; no owner, review, seal or reporter authority. Discovery profile is not an authorization boundary.',
    config_path: config.file, before_sha256: config.beforeHash, preserve_original_at: config.backup,
    local_change: 'Add mcpServers.qoopia (Claude JSON) or mcp_servers.qoopia (Codex TOML); store only a fresh scoped agent bearer key in this 0600 file.',
    endpoint, first_memory: { text: SAMPLE, suffix: 'A random nonsecret search marker is appended for exact recall verification.', visibility: 'workspace', retained: true },
    probe: 'Shipped MCP tools/list, qoopia_capabilities, note_create, note_get and FTS recall through an in-process SDK transport; no native launch or HTTP connection.',
    native_discovery: 'NOT RUN', native_model_identity: 'unknown', native_subscription: 'NOT RUN',
    native_binding: 'Publish a private nonsecret connection receipt binding this exact file, scoped agent and installed generation; native use remains an explicit local owner operation.',
    requires: 'Stopped installation, then --commit --approve EXACT_PREVIEW_DIGEST; start Qoopia and refresh the selected native connection afterward.',
  };
  const preview = { ...changes, preview_digest: hash(JSON.stringify(changes)) };
  if (approval === undefined) return { state: 'PREVIEW', ...preview };
  if (approval !== preview.preview_digest) throw new Error('Connect preview changed or approval mismatched; review a fresh preview');
  let agentId: string | undefined;
  let stage = 'PAIRING';
  try {
    const enrolled = db.transaction(() => {
      const pairing = issuePairing(owner, { name: input.name, runtime_id: input.runtime + ':' + input.name,
        profile: 'memory-worker', expected_revision: principal.policy_epoch, idempotency_key: randomUUID() });
      if (!pairing.one_time_code) throw new Error('Pairing requires a fresh owner decision');
      return redeemPairing(pairing.one_time_code);
    }).immediate();
    agentId = String(enrolled.data.agent_id);
    stage = 'AUTHENTICATE';
    const auth = authenticate(new Request(endpoint, { headers: { authorization: 'Bearer ' + enrolled.api_key } }));
    if (!auth || auth.agent_id !== agentId) throw new Error('Fresh scoped authentication failed');
    const client = new Client({ name: 'qoopia-connect', version: '1' });
    const server = createMcpServer(() => auth, 'full', { bootstrapProfile: 'memory-worker', agentToolProfile: 'no-destructive' });
    const [st, ct] = InMemoryTransport.createLinkedPair();
    let noteId = '', configDigest = '', tools: string[] = [];
    try {
      stage = 'CAPABILITY_PROBE';
      await server.connect(st); await client.connect(ct);
      const catalog = await client.listTools(); tools = catalog.tools.map(tool => tool.name);
      for (const name of ['qoopia_capabilities', 'note_create', 'note_get', 'recall']) if (!tools.includes(name)) throw new Error('Required memory tool unavailable');
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError || !Array.isArray(result.content)) throw new Error('Scoped MCP check failed: ' + name);
        const text = result.content.find(item => item.type === 'text');
        if (!text || typeof text.text !== 'string') throw new Error('MCP result missing');
        return JSON.parse(text.text);
      };
      const capability = await call('qoopia_capabilities', {});
      if (capability.profile !== 'memory-worker') throw new Error('Capability profile mismatch');
      configDigest = capability.config_digest;
      const marker = 'qoopiaconnect' + randomUUID().replaceAll('-', '');
      const sampleText = SAMPLE + ' ' + marker;
      stage = 'FIRST_MEMORY_WRITE';
      const note = await call('note_create', { type: 'memory', text: sampleText, visibility: 'workspace' });
      noteId = note.id;
      stage = 'FIRST_MEMORY_READ';
      const read = await call('note_get', { id: noteId });
      if (!noteId || read.id !== noteId || read.text !== sampleText) throw new Error('First memory readback mismatch');
      stage = 'FIRST_MEMORY_RECALL';
      const recall = await call('recall', { query: marker, scope: 'notes', limit: 5, deep: false, deep_llm: false });
      if (!JSON.stringify(recall).includes(noteId)) throw new Error('First memory recall missing');
    } finally { await client.close(); await server.close(); }
    // Recheck the owner's exact file state after asynchronous MCP work, before publishing credentials.
    stage = 'CONFIG_RECHECK';
    const again = configState(input, context.root);
    if (again.beforeHash !== config.beforeHash) throw new Error('Config changed during probe');
    const entry = { url: endpoint, headers: { Authorization: 'Bearer ' + enrolled.api_key } };
    const bytes = input.runtime === 'claude_code'
      ? JSON.stringify({ ...config.parsed, mcpServers: { ...(config.parsed.mcpServers as object), qoopia: { type: 'http', ...entry } } }, null, 2) + '\n'
      : config.text + '\n[mcp_servers.qoopia]\nurl = ' + JSON.stringify(endpoint) + '\nhttp_headers = { Authorization = ' + JSON.stringify(entry.headers.Authorization) + ' }\n';
    stage = 'CONFIG_PUBLISH';
    if (config.backup) durableWrite(config.backup, config.before!);
    durableWrite(config.file, bytes);
    stage = 'CONNECTION_RECEIPT';
    const connection = publishNativeConnection(db, { installation: context, runtime_kind: input.runtime,
      runtime_id: enrolled.data.runtime_registration_id, workspace_id: owner.workspace_id, agent_id: agentId,
      agent_epoch: auth.policy_epoch!, agent_session: auth.session_version!, owner_id: owner.agent_id,
      owner_epoch: principal.policy_epoch, owner_session: principal.session_version, config: config.file });
    return { state: 'CONFIGURED_LOCAL_PROBE_PASS', preview_digest: preview.preview_digest, agent_id: agentId,
      connection,
      runtime_registration_id: enrolled.data.runtime_registration_id, workspace_id: owner.workspace_id,
      config_path: config.file, preserved_original: config.backup, tools, config_digest: configDigest, first_memory_id: noteId,
      probe_transport: 'in-process SDK', native_discovery: 'NOT RUN', native_subscription: 'NOT RUN', native_model_identity: 'unknown',
      next_action: 'Start Qoopia, then refresh the selected native MCP connection. Native skill adapter/reporter enrollment and useful task qualification remain separate.' };
  } catch {
    if (agentId) revokePrincipal(owner, { agent_id: agentId, expected_revision: 1, idempotency_key: randomUUID() });
    throw new Error('Connect failed at ' + stage + '; any newly enrolled agent was revoked. Sample memory may remain. Inspect selected config and its previewed original snapshot before retry; no automatic deletion or restoration.');
  }
}
