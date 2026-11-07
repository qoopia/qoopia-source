import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/server';
import {grantedScopeAllowsRisk,type OAuthScope} from '../auth/oauth.ts';
import type {AuthContext} from '../auth/middleware.ts';
import {agentGuide,installationLanguage} from '../agent-kit/index.ts';
import {observeClientProtocol} from '../services/client-connections.ts';
import {noteAgentWork} from '../services/memory-policy.ts';
import {logger} from '../utils/logger.ts';
import {QoopiaError} from '../utils/errors.ts';
import {currentToolAuth} from '../auth/policy.ts';
import {db} from '../db/connection.ts';
import {executeCode,CODE_LIMITS} from './code-mode.ts';
import {addToolRisk,fail,riskOf,UNTRUSTED_CONTENT_LABEL} from './tools.ts';

export const LEAN_TOOLS=new Set(['recall','note_get','note_create','agent_inbox','agent_send','qoopia_guide','tool_search','qoopia_execute']);
const CONNECTION_TOOLS=new Set(['qoopia_protocol','connection_verify']);
/** Read-risk tools with effects beyond reading stay top-level only: connection_verify and the protocol/guide record
 * connection status, agent_inbox records delivery (code could discard what it marks delivered). */
const NOT_IN_CODE_MODE=new Set(['qoopia_execute','connection_verify','qoopia_protocol','qoopia_guide','agent_inbox']);
/** Code Mode never spends the owner's model: one run could otherwise start up to 50 judged or LLM-reranked recalls. */
export function codeModeArgs(name:string,args:Record<string,unknown>) {
  if(name!=='recall')return args;
  const next={...args};for(const key of ['judge','deep_llm'])if(key in next)next[key]=false;return next;
}
const shortDescriptions:Record<string,string>={recall:'Search memory. Returns excerpts and ids; fetch bodies with note_get. Fast by default.',note_get:'Read a note by id or batch ids. max_chars bounds each body.',note_create:'Remember a note with server deduplication.',agent_inbox:'Read messages addressed to this agent.',agent_send:'Send a message to another agent.'};
function compactSchema(value:any):any {if(Array.isArray(value))return value.map(compactSchema);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='description'&&k!=='$schema').map(([k,v])=>[k,compactSchema(v)]));return value;}

/** Presentation only: the original SDK dispatcher and its entire authorized registry stay intact. */
export function installToolSurface(server:McpServer,authProvider:()=>AuthContext|null,opts?:{bootstrapProfile?:string;grantedScope?:OAuthScope[]}) {
  const handlers=(server.server as any)._requestHandlers as Map<string,(request:any,ctx:any)=>Promise<any>>;
  const context=new AsyncLocalStorage<any>();
  const readAuth=()=>{const auth=authProvider();if(!auth)throw new QoopiaError('UNAUTHENTICATED','Authentication required');return currentToolAuth(db,auth,'read');};
  const register=(name:string,description:string,schema:z.ZodObject<any>,fn:(args:any)=>Promise<any>|any)=>{
    addToolRisk(name,'read');if(opts?.bootstrapProfile==='runtime-reporter'||!grantedScopeAllowsRisk(opts?.grantedScope,'read'))return;
    server.registerTool(name,{description,inputSchema:schema.strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async(args)=>{
      try{readAuth();return {content:[{type:'text' as const,text:JSON.stringify(await fn(args))}]};}catch(error){return fail(error);}
    });
  };
  register('qoopia_guide','Qoopia rules: no section gives a short index; section loads only that chapter.',z.object({section:z.string().max(100).optional(),language:z.enum(['ru','en']).optional()}),({section,language})=>{const auth=readAuth();observeClientProtocol(auth);return agentGuide(section,language??installationLanguage());});
  let catalog:()=>Promise<any[]>;
  register('tool_search','Find other callable tools by name or topic. Returns matching names, descriptions and input schemas.',z.object({query:z.string().trim().min(1).max(200),limit:z.number().int().min(1).max(8).default(3)}),async({query,limit})=>{
    const terms=query.toLowerCase().split(/\s+/),tools=await catalog();
    return {tools:tools.map(tool=>({tool,score:terms.reduce((sum:string|number,word:string)=>Number(sum)+(tool.name.toLowerCase().includes(word)?10:tool.description?.toLowerCase().includes(word)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.tool.name.localeCompare(b.tool.name)).slice(0,limit).map(x=>x.tool)};
  });
  if(process.env.QOOPIA_CODE_MODE!=='off')register('qoopia_execute','Run read-only JS with qoopia tools. Example: const r=await qoopia.recall({query:"plan"}); const n=await qoopia.note_get({ids:r.results.map(x=>x.id),max_chars:500}); return n.notes.filter(x=>x.text); No writes; recall judge off; 10s/50 calls/20KB.',z.object({code:z.string().min(1).max(20_000)}),async({code})=>{
    const auth=readAuth(),tools=await catalog(),ctx=context.getStore();
    const names=tools.filter(t=>riskOf(t.name)==='read'&&!NOT_IN_CODE_MODE.has(t.name)).map(t=>t.name);
    const result=await executeCode(code,names,async(name,args,signal)=>{
      if(signal.aborted)throw new QoopiaError('SIZE_LIMIT','Code Mode run ended');readAuth();logger.info(`MCP tools/call tool=${name} risk=read agent=${auth.agent_name} via=qoopia_execute`);noteAgentWork(auth.agent_id,name);
      const response=await call({method:'tools/call',params:{name,arguments:codeModeArgs(name,args)}},ctx);
      // Every refusal, APPROVAL_REQUIRED included, arrives as isError; remembered text that merely mentions it is data.
      if(response.isError)throw new QoopiaError('FORBIDDEN','Tool call refused');
      return response.content?.length===1&&response.content[0].type==='text'?JSON.parse(response.content[0].text):response;
    });
    const output={...result,untrusted_content:UNTRUSTED_CONTENT_LABEL};
    if(Buffer.byteLength(JSON.stringify(output))>CODE_LIMITS.output_bytes)throw new QoopiaError('SIZE_LIMIT','Code Mode output budget exceeded');
    return output;
  });
  const list=handlers.get('tools/list')!,call=handlers.get('tools/call')!;
  catalog=async()=>{const result=await list({method:'tools/list'},context.getStore());return result.tools;};
  handlers.set('tools/call',(req,ctx)=>context.run(ctx,()=>call(req,ctx)));
  handlers.set('tools/list',async(req,ctx)=>{
    const result=await list(req,ctx);if(process.env.QOOPIA_TOOL_SURFACE==='classic')return result;
    return {...result,tools:result.tools.filter((t:any)=>LEAN_TOOLS.has(t.name)||CONNECTION_TOOLS.has(t.name)).map((t:any)=>({...t,description:t.name==='note_create'&&t.inputSchema?.properties?.idempotency_key?shortDescriptions.note_create+' Use a stable idempotency_key for retries.':shortDescriptions[t.name]??(t.name==='qoopia_protocol'?'Legacy full protocol; prefer qoopia_guide for individual chapters.':t.description),inputSchema:compactSchema(t.inputSchema)}))};
  });
}
