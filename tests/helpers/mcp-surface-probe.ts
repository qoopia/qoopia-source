/** Prints the MCP surface a steward is offered with the feature flags its parent set. Module
 * flags are read at load, so tests/mcp-surface-flags.test.ts runs this in a fresh process. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {runMigrations} from '../../src/db/migrate.ts';
import {createWorkspace} from '../../src/admin/workspaces.ts';
import {createAgent} from '../../src/admin/agents.ts';
import {createMcpServer} from '../../src/mcp/server.ts';
import {riskOf} from '../../src/mcp/tools.ts';
import type {AuthContext} from '../../src/auth/middleware.ts';

runMigrations();
const slug = 'surface-' + process.pid;
const ws = createWorkspace({name: 'MCP surface probe', slug});
const agent = createAgent({name: slug + '-steward', workspaceSlug: ws.slug, type: 'steward'});
const auth: AuthContext = {agent_id: agent.id, agent_name: slug + '-steward', workspace_id: ws.id, type: 'steward', source: 'api-key', tool_profile: 'full'};
const server = createMcpServer(() => auth, 'full', {isSteward: true, agentToolProfile: 'full'});
const client = new Client({name: 'surface-probe', version: '1'});
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport); await client.connect(clientTransport);
const {tools} = await client.listTools();
const capabilities = await client.callTool({name: 'qoopia_capabilities', arguments: {}});
const operations = JSON.parse((capabilities.content as {text: string}[])[0]!.text).operations as {name: string; input_schema: {properties?: object}}[];
console.log(JSON.stringify({
  tools: tools.map(t => ({name: t.name, properties: Object.keys(t.inputSchema.properties ?? {}).sort(), annotations: t.annotations ?? null, risk: riskOf(t.name)})),
  operations: operations.map(op => ({name: op.name, properties: Object.keys(op.input_schema.properties ?? {}).sort()})),
}));
await client.close(); await server.close();
