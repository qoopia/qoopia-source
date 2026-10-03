import {agentProtocol,MCP_INSTRUCTIONS} from '../agent-kit/index.ts';
import {z} from "zod";
import {verifyClientConnection,observeClientProtocol} from "../services/client-connections.ts";
import {QoopiaError} from "../utils/errors.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fail,
  registerTools,
  type ToolProfile,
  type AgentToolProfile,
  toolNames,
} from "./tools.ts";
import type { OAuthScope } from "../auth/oauth.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { PRODUCT_VERSION } from "../utils/product-version.ts";
import { registerAuthorityTools } from "../api/authority.ts";
import { bootstrapToolAllowed } from "../auth/policy.ts";
import {registerBridgeTools} from '../bridges/api.ts';

/** SDK-level tool failures (schema validation, unknown tool) in the '<CODE>: <message>' shape of
 * every Qoopia tool error. The detail is bounded: it can quote a caller-chosen key or tool name. */
function sdkToolError(message: string) {
  const detail = message.replace(/^MCP error -?\d+: /, '').replace(/^Input validation error: Invalid arguments for tool [^:]*: /, '');
  const code = /^Tool .* (?:not found|disabled)$/s.test(detail) ? 'NOT_FOUND' : message.startsWith('MCP error -32602') ? 'INVALID_INPUT' : 'INTERNAL';
  return {isError: true, content: [{type: 'text' as const, text: `${code}: ${detail.replace(/\s+/g, ' ').slice(0, 500)}`}]};
}

export function createMcpServer(
  authProvider: () => AuthContext | null,
  profile: ToolProfile = "full",
  opts?: {
    isSteward?: boolean;
    agentToolProfile?: AgentToolProfile;
    grantedScope?: OAuthScope[];
    bootstrapProfile?: string;
  },
): McpServer {
  const server = new McpServer({
    name: "qoopia",
    version: PRODUCT_VERSION,
  },{instructions:MCP_INSTRUCTIONS});
  // ponytail: replaces the SDK's private error formatter (its only funnel for these failures);
  // tests/mcp-error-shape.test.ts fails if an SDK upgrade renames it.
  (server as unknown as {createToolError:(message:string)=>unknown}).createToolError=sdkToolError;
  server.registerTool('qoopia_protocol',{
    description:'Read the versioned Qoopia operating protocol before using this connection. Includes ChatGPT/Claude MCP reconnect, memory, agents, health and bridges. Documentation only; discover actual tools/scopes separately. language en returns the English text (default ru).',
    inputSchema:z.object({section:z.enum(['protocol','connections','operations','soul']).default('protocol'),language:z.enum(['ru','en']).default('ru')}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({section,language})=>{
    try{const auth=authProvider();if(!auth)throw new QoopiaError('UNAUTHENTICATED','Authentication required');
      const text=JSON.stringify(agentProtocol(section,language));observeClientProtocol(auth);
      return {content:[{type:'text' as const,text}]};
    }catch(error){return fail(error);}
  });
  if(authProvider()?.connection_id)server.registerTool('connection_verify',{
    description:'Confirm this client can call its Qoopia connection using the verification challenge from the owner setup wizard. No memory content is read.',
    inputSchema:z.object({connection_id:z.string().uuid(),challenge:z.string().min(1).max(100)}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async({connection_id,challenge})=>{
    try {const auth=authProvider();if(!auth)throw new Error('UNAUTHENTICATED');
      return {content:[{type:'text' as const,text:JSON.stringify(verifyClientConnection(auth,connection_id,challenge))}]};
    }catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof QoopiaError&&error.code==='VERIFICATION_ALREADY_COMPLETED'
      ?error.toString():'VERIFICATION_REFUSED: Check the connection and request a fresh verification prompt.'}]};}
  });
  registerTools(server, authProvider, profile, opts);
  registerAuthorityTools(server, authProvider, new Set(toolNames(profile).filter((name) => bootstrapToolAllowed(name, opts?.bootstrapProfile))));
  registerBridgeTools(server,authProvider);
  return server;
}
