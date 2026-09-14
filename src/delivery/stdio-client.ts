import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,McpError} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {setTimeout as delay} from 'node:timers/promises';
import {stdioBindingSchema,stdioAuthStatus,stdioFolder,StdioOAuthProvider,stdioFetch,StdioAccessError,lockStdioCredentials} from './stdio-oauth.ts';

async function waitForCredentials(folder:string,signal:AbortSignal) {
  const deadline=Date.now()+5000;
  for(;;){
    signal.throwIfAborted();
    try{return lockStdioCredentials(folder);}
    catch(error){
      if(!(error instanceof StdioAccessError)||error.code!=='CLIENT_AUTH_BUSY'||Date.now()>=deadline)throw error;
      await delay(25,undefined,{signal});
    }
  }
}

/** Bridge tools through the selected HTTP service; this process never opens the memory database.
 * Each upstream call holds the private OAuth lock so refresh rotation is serialized across clients.
 * An interrupted write is returned as unavailable. Only an explicit subsequent client request retries it.
 */
export async function serveStdioClient(root:string,raw:unknown,transport:Transport=new StdioServerTransport(undefined,undefined,{maxBufferSize:2*1024*1024})) {
  const binding=stdioBindingSchema.parse(raw);
  const server=new Server({name:'qoopia-local-adapter',version:'1'},{capabilities:{tools:{}}});
  const closed=new AbortController();let pending=Promise.resolve();
  const forward=<T>(signal:AbortSignal,call:(client:Client,signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    const run=async()=>{
      const combined=AbortSignal.any([signal,closed.signal]);if(combined.aborted)throw new McpError(-32001,'CLIENT_REQUEST_CANCELLED');
      let release:(()=>void)|undefined,client:Client|undefined;
      try{
        // Desktop can start multiple adapter processes. Wait before touching OAuth or
        // sending anything upstream; never retry an interrupted memory operation.
        release=await waitForCredentials(stdioFolder(root,binding),combined);
        if(!stdioAuthStatus(root,binding).credentials_present)throw new StdioAccessError('CLIENT_AUTH_REQUIRED');
        const provider=new StdioOAuthProvider(stdioFolder(root,binding),binding);
        const request=stdioFetch(binding,((input:Request|string|URL,init?:RequestInit)=>fetch(input,{...init,
          signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),combined])})) as typeof fetch);
        client=new Client({name:'qoopia-local-adapter-for-claude-desktop',version:'1'});
        await client.connect(new StreamableHTTPClientTransport(new URL(binding.mcp_url),{authProvider:provider,fetch:request,
          reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}}));
        return await call(client,combined);
      }catch(error){
        const code=combined.aborted?'CLIENT_REQUEST_CANCELLED':error instanceof StdioAccessError?error.code:'CLIENT_SERVICE_UNAVAILABLE';
        throw new McpError(-32001,code+': Check this connection in Qoopia. After an interrupted write, reuse its idempotency key and exact payload.');
      }finally{try{await client?.close();}finally{release?.();}}
    };
    const result=pending.then(run,run);pending=result.then(()=>{},()=>{});return result;
  };
  server.setRequestHandler(ListToolsRequestSchema,(request,extra)=>forward(extra.signal,(client,signal)=>client.listTools(request.params,{signal,timeout:30_000})));
  server.setRequestHandler(CallToolRequestSchema,(request,extra)=>forward(extra.signal,(client,signal)=>client.callTool(request.params,undefined,{signal,timeout:30_000})));
  server.onclose=()=>closed.abort();
  // Never echo SDK errors: upstream messages can contain request content or credentials.
  server.onerror=()=>{};
  await server.connect(transport);return {close:async()=>{closed.abort();await server.close();await pending;}};
}
