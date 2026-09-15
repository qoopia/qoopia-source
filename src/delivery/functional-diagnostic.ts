import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { bindNativeConnection, connectionLaunch, connectionRefSchema } from '../skills/connection.ts';
import { hash } from '../utils/fs.ts';

const inputSchema=z.object({runtime_kind:z.enum(['codex','claude_code']),connection:connectionRefSchema}).strict();
type Expected={root:string;instance:string;bundle:string;generation:string;port:number;build:string;version:string;schema:number};

function parseMcp(text:string){
  try{return JSON.parse(text);}catch{}
  const frames=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(Boolean);
  for(let i=frames.length-1;i>=0;i--)try{return JSON.parse(frames[i]!);}catch{}
  throw new Error('invalid MCP response');
}

/** Explicit live check only. The read-only doctor never calls this function. */
export async function functionalDiagnostic(database:Database,raw:unknown,expected:Expected){
  const input=inputSchema.parse(raw);let stage='CONFIG_IDENTITY',noteId='',marker='';
  try{
    const bound=bindNativeConnection(database,input.connection,{runtime_id:input.connection.runtime_id,runtime_kind:input.runtime_kind,workspace_id:input.connection.workspace_id});
    const connection=connectionLaunch(bound,input.connection,input.runtime_kind,expected.root);
    const endpoint=new URL(connection.endpoint);
    if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.port!==String(expected.port)||endpoint.pathname!=='/mcp'||endpoint.search||endpoint.hash)throw new Error('endpoint mismatch');
    stage='LISTENER_IDENTITY';
    const healthResponse=await fetch(new URL('/health',endpoint),{redirect:'error',signal:AbortSignal.timeout(5_000)});
    const health=await healthResponse.json() as Record<string,unknown>;
    if(healthResponse.status!==200||health.status!=='ok'||health.version!==expected.version||health.release_sha!==expected.build||health.build_commit!==expected.build||health.schema_version!==expected.schema||health.server_role!=='canonical'||health.instance_id!==expected.instance||health.writes_enabled!==true)throw new Error('listener mismatch');
    const call=async(name:string,args:Record<string,unknown>)=>{
      const response=await fetch(connection.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{authorization:connection.bearer,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
      if(response.status!==200)throw new Error('HTTP '+response.status);
      const body=parseMcp(await response.text());
      if(body.error||body.result?.isError)throw new Error('MCP refusal');
      const text=body.result?.content?.find((item:{type?:unknown})=>item.type==='text')?.text;
      if(typeof text!=='string')throw new Error('MCP result missing');
      return JSON.parse(text);
    };
    stage='LIVE_AUTH';
    const capability=await call('qoopia_capabilities',{});
    if(capability.profile!=='memory-worker'||!/^[a-f0-9]{64}$/.test(capability.config_digest??''))throw new Error('capability mismatch');
    marker='qoopiafunctionaldiagnostic'+randomUUID().replaceAll('-','');
    const fixture=`Qoopia explicit functional diagnostic fixture. Safe to retain for operator inspection. Marker ${marker}`;
    stage='WRITE';const created=await call('note_create',{type:'memory',text:fixture,visibility:'workspace'});noteId=created.id;
    if(typeof noteId!=='string'||!noteId)throw new Error('note id missing');
    stage='READ';const read=await call('note_get',{id:noteId});if(read.id!==noteId||read.text!==fixture)throw new Error('read mismatch');
    stage='RECALL';const recalled=await call('recall',{query:marker,scope:'notes',limit:5,deep:false,deep_llm:false});const serialized=JSON.stringify(recalled);
    if(!serialized.includes(noteId)||!serialized.includes(marker))throw new Error('recall mismatch');
    return {status:'PASS_FUNCTIONAL_DIAGNOSTIC',transport:'authenticated shipped HTTP MCP over exact installed loopback',instance:expected.instance,build:expected.build,bundle:expected.bundle,generation:expected.generation,config_identity_sha256:input.connection.sha256,authority_profile:capability.profile,config_digest:capability.config_digest,fixture_marker:marker,note_id:noteId,write:true,read_exact:true,recall_found:true,cleanup:'none; identifiable diagnostic fixture retained'};
  }catch{
    throw new Error(`FUNCTIONAL_DIAGNOSTIC_${stage}; no automatic cleanup${noteId?`; diagnostic note ${noteId} with marker ${marker} may remain`:''}`);
  }
}
