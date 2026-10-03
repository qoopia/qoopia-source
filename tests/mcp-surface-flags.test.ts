/** The MCP surface with every feature flag on, read from a fresh process (flags are read at module load). */
import {beforeAll, expect, test} from 'bun:test';
import path from 'node:path';
import {riskOf} from '../src/mcp/tools.ts';
import {BRIDGE_TOOL_NAMES} from '../src/bridges/api.ts';
import '../src/mcp/server.ts'; // loads every registration path, as mcp-route does

type Surface = {
  tools: {name: string; properties: string[]; annotations: Record<string, unknown> | null; risk: string | null}[];
  operations: {name: string; properties: string[]}[];
};
let surface: Surface;
beforeAll(() => {
  const flags = Object.fromEntries(['QOOPIA_SKILLS', 'QOOPIA_ENTITY_PAGES', 'QOOPIA_V4_RELATIONS', 'QOOPIA_V4_LATEST_ONLY', 'QOOPIA_V4_EXTRACTION',
    'QOOPIA_V4_RECALL_EXPLAIN', 'QOOPIA_V4_FEEDBACK', 'QOOPIA_V4_BITEMPORAL'].map(name => [name, 'true']));
  const child = Bun.spawnSync({cmd: [process.execPath, path.join(import.meta.dir, 'helpers/mcp-surface-probe.ts')],
    env: {...process.env, ...flags}, stdout: 'pipe', stderr: 'pipe'});
  if (child.exitCode !== 0) throw new Error(`probe exit=${child.exitCode}\n${child.stderr.toString()}`);
  surface = JSON.parse(child.stdout.toString().trim().split('\n').pop()!);
}, 60_000);

test('F-257: every operation qoopia_capabilities publishes has the schema of the MCP tool of that name', () => {
  const tools = new Map(surface.tools.map(t => [t.name, t.properties]));
  expect(tools.has('skill_search')).toBe(true);
  const mismatched = surface.operations.filter(op => tools.has(op.name) && JSON.stringify(op.properties) !== JSON.stringify(tools.get(op.name)));
  expect(mismatched).toEqual([]);
});

test('F-260: the access log knows the risk class of every tool a connection can call', () => {
  expect(surface.tools.filter(t => t.risk === null).map(t => t.name)).toEqual([]);
  expect(surface.tools.find(t => t.name === 'skill_feedback')?.risk).toBe('write-low');
  expect(surface.tools.find(t => t.name === 'operation_get')?.risk).toBe('read');
  expect(riskOf('skill_seal')).toBe('admin');
  expect(riskOf('connection_verify')).toBe('write-low');
  expect(BRIDGE_TOOL_NAMES.map(name => [name, riskOf(name)])).toEqual(BRIDGE_TOOL_NAMES.map(name =>
    [name, ['bridge_status', 'bridge_catalogue', 'bridge_material'].includes(name) ? 'read' : 'write-low']));
});

test('F-258: every tool carries effect annotations; read-only exactly when its risk is read', () => {
  expect(surface.tools.filter(t => typeof t.annotations?.readOnlyHint !== 'boolean').map(t => t.name)).toEqual([]);
  expect(surface.tools.filter(t => t.annotations!.readOnlyHint !== (t.risk === 'read')).map(t => t.name)).toEqual([]);
  expect(surface.tools.filter(t => t.annotations!.destructiveHint !== (t.risk === 'write-destructive' || t.risk === 'admin')).map(t => t.name)).toEqual([]);
});
