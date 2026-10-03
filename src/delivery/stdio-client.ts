import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport,StreamableHTTPError} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {setTimeout as delay} from 'node:timers/promises';
import {MCP_INSTRUCTIONS} from '../agent-kit/index.ts';
import {stdioBindingSchema,stdioFolder,StdioOAuthProvider,stdioFetch,StdioAccessError,lockStdioCredentials,type StdioBinding} from './stdio-oauth.ts';

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

/** Refresh rotates the one-time refresh token, so it runs under the private cross-process OAuth lock.
 * Another adapter process may have rotated it already: then its stored token is used as is. */
async function refreshCredentials(folder:string,binding:StdioBinding,used:string,request:typeof fetch,signal:AbortSignal) {
  const release=await waitForCredentials(folder,signal);
  try{
    const provider=new StdioOAuthProvider(folder,binding);
    if(provider.tokens()?.access_token!==used)return;
    const resourceMetadataUrl=new URL(new URL(binding.mcp_url).origin+'/.well-known/oauth-protected-resource/mcp/c/'+binding.connection_id);
    if(await auth(provider,{serverUrl:binding.mcp_url,scope:provider.clientMetadata.scope,resourceMetadataUrl,fetchFn:request})!=='AUTHORIZED')
      throw new StdioAccessError('CLIENT_AUTH_REQUIRED');
  }finally{release();}
}
/** The JSON-RPC message, without the McpError prefix the client adds again on its side. */
const adapterError=(message:string)=>Object.assign(new Error(message),{code:-32001});

/** Bridge tools through the selected HTTP service; this process never opens the memory database.
 * A call reads the stored access token without the OAuth lock, so a long call never blocks another
 * Desktop process; only a token refresh takes the lock. A 401 is refused before any tool runs, so the
 * call is sent once more after the refresh. An interrupted write is returned as unavailable.
 * Only an explicit subsequent client request retries it.
 */
export async function serveStdioClient(root:string,raw:unknown,transport:Transport=new StdioServerTransport(undefined,undefined,{maxBufferSize:2*1024*1024})) {
  const binding=stdioBindingSchema.parse(raw),folder=stdioFolder(root,binding);
  // Desktop reads no CLAUDE.md: the bootstrap rule reaches it only as these instructions.
  const server=new Server({name:'qoopia-local-adapter',version:'1'},{capabilities:{tools:{}},instructions:MCP_INSTRUCTIONS});
  const closed=new AbortController();let pending=Promise.resolve();
  const forward=<T>(signal:AbortSignal,call:(client:Client,signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    const run=async()=>{
      const combined=AbortSignal.any([signal,closed.signal]);if(combined.aborted)throw adapterError('CLIENT_REQUEST_CANCELLED');
      const request=stdioFetch(binding,((input:Request|string|URL,init?:RequestInit)=>fetch(input,{...init,
        signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),combined])})) as typeof fetch);
      try{
        for(let refreshed=false;;refreshed=true){
          const access=new StdioOAuthProvider(folder,binding).tokens()?.access_token;
          if(!access)throw new StdioAccessError('CLIENT_AUTH_REQUIRED');
          const client=new Client({name:'qoopia-local-adapter-for-claude-desktop',version:'1'});
          try{
            await client.connect(new StreamableHTTPClientTransport(new URL(binding.mcp_url),{fetch:request,requestInit:{headers:{authorization:'Bearer '+access}},
              reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}}));
            return await call(client,combined);
          }catch(error){
            if(refreshed||!(error instanceof StreamableHTTPError)||error.code!==401)throw error;
          }finally{await client.close();}
          await refreshCredentials(folder,binding,access,request,combined);
        }
      }catch(error){
        const code=combined.aborted?'CLIENT_REQUEST_CANCELLED':error instanceof StdioAccessError?error.code:'CLIENT_SERVICE_UNAVAILABLE';
        throw adapterError(code+': Check this connection in Qoopia. After an interrupted write, reuse its idempotency key and exact payload.');
      }
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
