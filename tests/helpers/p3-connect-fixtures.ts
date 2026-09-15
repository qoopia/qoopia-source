// Shared by the source suite and the separate compiled installed/HTTP gate.
// Type-only domain imports keep the compiled harness from opening the source DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import type { z } from 'zod';
import type { connectInput, connectInstalled } from '../../src/delivery/connect.ts';
import type { Principal } from '../../src/auth/policy.ts';
import type { getNote } from '../../src/services/notes.ts';
import { hash } from '../../src/utils/fs.ts';

export type ConnectInput = z.infer<typeof connectInput>;
export type ConnectContext = Parameters<typeof connectInstalled>[1];
export type ConnectResult = Awaited<ReturnType<typeof connectInstalled>>;
export type ConfiguredConnect = Extract<ConnectResult, { agent_id: string }>;
export const connectRuntimes = ['claude_code', 'codex'] as const satisfies readonly ConnectInput['runtime'][];

export function connectConfigFixture(outer: string, runtime: ConnectInput['runtime'], existing: boolean) {
  const home = path.join(outer, runtime + (existing ? '-existing' : '-fresh'));
  fs.mkdirSync(home, { mode: 0o700 });
  const config = path.join(home, runtime === 'codex' ? 'config.toml' : '.mcp.json');
  const original = runtime === 'codex'
    ? '# retained comment\nmodel = "unrelated-fixture-secret"\n[mcp_servers.other]\nurl = "http://127.0.0.1:9/mcp"\n'
    : '{"extra":"unrelated-fixture-secret","mcpServers":{"other":{"type":"http","url":"http://127.0.0.1:9/mcp"}}}\n';
  if (existing) fs.writeFileSync(config, original, { mode: 0o600 });
  return { runtime, existing, home, config, original };
}

export function connectState(database: Database) {
  return JSON.stringify({ agents: database.query('SELECT id,active,policy_epoch FROM agents ORDER BY id').all(),
    notes: database.query('SELECT id,text FROM notes ORDER BY id').all(),
    pairings: database.query('SELECT id FROM agent_pairings ORDER BY id').all() });
}

export function assertConnectOutput(output: string) {
  assert(!/q_[A-Za-z0-9_-]{43}/.test(output), 'No credential output');
  assert(!output.includes('unrelated-fixture-secret'), 'No prior config values in output');
}

export function assertConnectPreview(result: ConnectResult): asserts result is Extract<ConnectResult, { profile: string }> {
  assert.equal(result.state, 'PREVIEW');
  assert('profile' in result);
  assert.equal(result.profile, 'memory-worker');
  assert.equal(result.native_model_identity, 'unknown');
  assert.match(result.preview_digest, /^[a-f0-9]{64}$/);
  assertConnectOutput(JSON.stringify(result));
}

export function assertConfiguredConnect(database: Database, fixture: ReturnType<typeof connectConfigFixture>,
  result: ConnectResult, context: ConnectContext): asserts result is ConfiguredConnect {
  assert.equal(result.state, 'CONFIGURED_LOCAL_PROBE_PASS');
  assert('agent_id' in result);
  assert.equal(result.native_subscription, 'NOT RUN');
  assert.equal(result.native_discovery, 'NOT RUN');
  assert.equal(result.native_model_identity, 'unknown');
  assert.equal(result.probe_transport, 'in-process SDK');
  assertConnectOutput(JSON.stringify(result));
  const { runtime, config, existing, original } = fixture;
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(result.config_path, config);
  assert.equal(result.preserved_original, existing ? config + '.qoopia-before-' + hash(original) : null);
  if (existing) {
    assert(result.preserved_original);
    assert.equal(fs.readFileSync(result.preserved_original, 'utf8'), original);
    assert.equal(fs.statSync(result.preserved_original).mode & 0o777, 0o600);
  }
  const text = fs.readFileSync(config, 'utf8');
  const parsed = runtime === 'codex' ? Bun.TOML.parse(text) : JSON.parse(text);
  if (existing) {
    assert.equal(runtime === 'codex' ? parsed.model : parsed.extra, 'unrelated-fixture-secret');
    assert((runtime === 'codex' ? parsed.mcp_servers : parsed.mcpServers).other);
  }
  const entry = (runtime === 'codex' ? parsed.mcp_servers : parsed.mcpServers).qoopia;
  assert.equal(entry.url, `http://127.0.0.1:${context.port}/mcp`);
  const authorization = (runtime === 'codex' ? entry.http_headers : entry.headers).Authorization;
  assert(/^Bearer q_[A-Za-z0-9_-]{43}$/.test(authorization), 'Scoped bearer format');
  const token = authorization.split(' ')[1];
  const principal = database.query<Pick<Principal, 'authority_profile' | 'tool_profile' | 'principal_kind'> & { api_key_hash: string }, [string]>(
    'SELECT authority_profile,tool_profile,principal_kind,api_key_hash FROM agents WHERE id=?').get(result.agent_id);
  assert(principal);
  assert.deepEqual([principal.authority_profile, principal.tool_profile, principal.principal_kind], ['memory-worker', 'no-destructive', 'agent']);
  assert.equal(principal.api_key_hash, hash(token));
  const note = database.query<Pick<ReturnType<typeof getNote>, 'agent_id' | 'workspace_id' | 'visibility' | 'text'>, [string]>(
    'SELECT agent_id,workspace_id,visibility,text FROM notes WHERE id=?').get(result.first_memory_id);
  assert(note);
  assert.equal(note.agent_id, result.agent_id); assert.equal(note.workspace_id, result.workspace_id);
  assert.equal(note.visibility, 'workspace'); assert(note.text.includes('(sample)'));
  for (const name of ['qoopia_capabilities', 'note_create', 'note_get', 'recall']) assert(result.tools.includes(name));
  assert(!result.tools.includes('agent_pairing_create')); assert(!result.tools.includes('skill_observe'));
  assert.match(result.config_digest, /^[a-f0-9]{64}$/);
}
