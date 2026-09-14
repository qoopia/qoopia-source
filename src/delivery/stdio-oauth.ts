import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {z} from 'zod/v4';
import {auth,type OAuthClientProvider,type OAuthDiscoveryState} from '@modelcontextprotocol/sdk/client/auth.js';
import {OAuthTokensSchema,OAuthClientInformationSchema,type OAuthTokens,type OAuthClientInformationMixed} from '@modelcontextprotocol/sdk/shared/auth.js';
import {privateDirectory,durableWrite,readJsonBytes,safePath} from './files.ts';
import {resourceOrigin} from '../auth/resource-origin.ts';

export const stdioBindingSchema=z.object({format:z.literal('qoopia-client-connection/1'),connection_id:z.string().uuid(),
  workspace_id:z.string().min(1).max(128),surface:z.literal('claude_desktop'),access_mode:z.enum(['read','read_write']),mcp_url:z.string().url()}).strict()
  .superRefine((value,ctx)=>{try{const url=new URL(value.mcp_url);resourceOrigin(url.origin);
    if(value.mcp_url!==url.origin+'/mcp/c/'+value.connection_id)throw new Error();
  }catch{ctx.addIssue({code:'custom',message:'Use the exact prepared Qoopia connection URL'});}});
export type StdioBinding=z.infer<typeof stdioBindingSchema>;
const storedSchema=z.object({format:z.literal('qoopia-stdio-oauth/1'),binding:stdioBindingSchema,redirect_uri:z.string().url(),
  client:OAuthClientInformationSchema.optional(),tokens:OAuthTokensSchema.optional(),saved_at:z.number().optional()}).strict();
type Stored=z.infer<typeof storedSchema>;
export class StdioAccessError extends Error {
  constructor(readonly code:'CLIENT_AUTH_REQUIRED'|'CLIENT_AUTH_BUSY'|'CLIENT_AUTH_EXPIRED'|'CLIENT_AUTH_REFUSED'|'CLIENT_SERVICE_UNAVAILABLE') {super(code);}
}
function ownedFile(file:string) {
  const bytes=readJsonBytes(file),s=fs.lstatSync(file);
  if(s.uid!==process.getuid!()||(s.mode&0o077)||bytes.length>65_536)throw new StdioAccessError('CLIENT_AUTH_REFUSED');
  return bytes;
}
export function stdioFolder(root:string,binding:StdioBinding) {return safePath(path.join(root,'client-configs',binding.connection_id));}
/** Separate OS-backed lock, never the workspace database. A crashed adapter cannot retain it. */
export function lockStdioCredentials(folder:string) {
  privateDirectory(folder);const file=safePath(path.join(folder,'oauth-lock.sqlite'));
  if(fs.existsSync(file))ownedFile(file);
  const database=new Database(file,{create:true});fs.chmodSync(file,0o600);
  try{database.run('PRAGMA busy_timeout=0');database.run('CREATE TABLE IF NOT EXISTS lock_state(id INTEGER PRIMARY KEY)');database.run('BEGIN IMMEDIATE');}
  catch{database.close();throw new StdioAccessError('CLIENT_AUTH_BUSY');}
  return ()=>{try{database.run('ROLLBACK');}finally{database.close();}};
}
function load(folder:string,binding:StdioBinding):Stored|undefined {
  const file=path.join(folder,'oauth.json');if(!fs.existsSync(file))return;
  const value=storedSchema.parse(JSON.parse(ownedFile(file).toString()));
  if(JSON.stringify(value.binding)!==JSON.stringify(binding))throw new StdioAccessError('CLIENT_AUTH_REFUSED');
  const redirect=new URL(value.redirect_uri);
  if(redirect.origin!=='http://127.0.0.1:'+redirect.port||!redirect.port||redirect.username||redirect.password||redirect.pathname!=='/qoopia/callback'||redirect.search||redirect.hash)
    throw new StdioAccessError('CLIENT_AUTH_REFUSED');
  return value;
}
export function stdioAuthStatus(root:string,raw:unknown) {
  const binding=stdioBindingSchema.parse(raw),value=load(stdioFolder(root,binding),binding);
  return {format:'qoopia-connections/1',state:'requires_user_action',code:value?.tokens?'CLIENT_CALL_REQUIRED':'CLIENT_AUTH_REQUIRED',
    credentials_present:!!value?.tokens,verified:false,next_action:value?.tokens?'Restart Claude Desktop and run the verification prompt.':'Approve this connection with Qoopia client-auth, then restart Claude Desktop.'};
}

/** Restrict all credential-bearing requests to the selected installation. Never follow HTTP redirects. */
export function stdioFetch(binding:StdioBinding,request:typeof fetch=fetch):typeof fetch {
  const origin=new URL(binding.mcp_url).origin;
  return (async(input:Request|string|URL,init?:RequestInit)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if(url.origin!==origin||url.username||url.password||url.hash||
      !(url.href===binding.mcp_url||url.pathname.startsWith('/.well-known/oauth-')||url.pathname.startsWith('/oauth/')))
      throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    return request(input,{...init,redirect:'error',signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(30_000)])});
  }) as typeof fetch;
}
export class StdioOAuthProvider implements OAuthClientProvider {
  private stored:Stored;
  private verifier?:string;
  private discovery?:OAuthDiscoveryState;
  private nonce=randomBytes(32).toString('base64url');
  readonly issuer:string;
  constructor(readonly folder:string,readonly binding:StdioBinding,redirect?:string,readonly onAuthorization?:(url:URL)=>void) {
    this.stored=load(folder,binding)??{format:'qoopia-stdio-oauth/1',binding,redirect_uri:redirect??'http://127.0.0.1:1/qoopia/callback'};
    if(redirect&&redirect!==this.stored.redirect_uri)throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    this.issuer=new URL(binding.mcp_url).origin+'/oauth/c/'+binding.connection_id;
  }
  get redirectUrl(){return this.stored.redirect_uri;}
  get clientMetadata(){return {client_name:'Qoopia local adapter for Claude Desktop',redirect_uris:[this.redirectUrl],
    token_endpoint_auth_method:'none' as const,grant_types:['authorization_code','refresh_token'],response_types:['code'],
    scope:this.binding.access_mode==='read'?'mcp:read':'mcp:read mcp:write'};}
  state(){return this.nonce;}
  clientInformation(){return this.stored.client;}
  saveClientInformation(value:OAuthClientInformationMixed){
    if(value.client_secret)throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    this.stored.client=OAuthClientInformationSchema.parse(value);this.save();
  }
  tokens(){return this.stored.tokens;}
  saveTokens(value:OAuthTokens){
    const token=OAuthTokensSchema.parse(value),allowed=new Set(this.clientMetadata.scope.split(' '));
    if(token.token_type.toLowerCase()!=='bearer'||token.scope?.split(' ').some(s=>!allowed.has(s)))throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    this.stored.tokens=token;this.stored.saved_at=Date.now();this.save();
  }
  saveCodeVerifier(value:string){this.verifier=value;}
  codeVerifier(){if(!this.verifier)throw new StdioAccessError('CLIENT_AUTH_REQUIRED');return this.verifier;}
  redirectToAuthorization(url:URL){
    if(!this.onAuthorization)throw new StdioAccessError('CLIENT_AUTH_REQUIRED');
    if(url.origin!==new URL(this.binding.mcp_url).origin||url.pathname!=='/oauth/authorize'||
      url.searchParams.get('connection')!==this.binding.connection_id||url.searchParams.get('resource')!==this.binding.mcp_url||
      url.searchParams.get('redirect_uri')!==this.redirectUrl||url.searchParams.get('state')!==this.nonce||url.searchParams.get('code_challenge_method')!=='S256')
      throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    this.onAuthorization(url);
  }
  async validateResourceURL(server:string|URL,resource?:string){
    if(String(server)!==this.binding.mcp_url||resource!==this.binding.mcp_url)throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    return new URL(resource);
  }
  saveDiscoveryState(value:OAuthDiscoveryState){
    const metadata=value.authorizationServerMetadata;
    if(value.authorizationServerUrl!==this.issuer||metadata?.issuer!==this.issuer||value.resourceMetadata?.resource!==this.binding.mcp_url)
      throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    const origin=new URL(this.binding.mcp_url).origin;
    if(metadata.token_endpoint!==origin+'/oauth/token'||metadata.authorization_endpoint!==origin+'/oauth/authorize?connection='+this.binding.connection_id||
      metadata.registration_endpoint!==origin+'/oauth/register?connection='+this.binding.connection_id)throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    this.discovery=value;
  }
  discoveryState(){return this.discovery;}
  invalidateCredentials(scope:'all'|'client'|'tokens'|'verifier'|'discovery'){
    if(scope==='all'||scope==='client')delete this.stored.client;
    if(scope==='all'||scope==='tokens')delete this.stored.tokens;
    if(scope==='all'||scope==='verifier')this.verifier=undefined;
    if(scope==='all'||scope==='discovery')this.discovery=undefined;
    this.save();
  }
  private save(){privateDirectory(this.folder);durableWrite(path.join(this.folder,'oauth.json'),JSON.stringify(storedSchema.parse(this.stored)));}
}

/** Explicit human OAuth flow. The callback, verifier and state expire with this process. */
export async function authorizeStdioClient(root:string,raw:unknown,onReady:(step:{open_url:string;expires_at:number})=>void,
  options:{request?:typeof fetch;timeoutMs?:number;signal?:AbortSignal}={}) {
  const binding=stdioBindingSchema.parse(raw),folder=stdioFolder(root,binding),release=lockStdioCredentials(folder);
  let server:http.Server|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let abort:(()=>void)|undefined;const deadline=new AbortController();
  try{
    const existing=load(folder,binding),port=existing?Number(new URL(existing.redirect_uri).port):0;
    let provider:StdioOAuthProvider,accept!:(code:string)=>void,refuse!:(error:Error)=>void,used=false;
    const code=new Promise<string>((resolve,reject)=>{accept=resolve;refuse=reject;});void code.catch(()=>{});
    server=http.createServer((req,res)=>{
      res.setHeader('cache-control','no-store');res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('referrer-policy','no-referrer');
      let url:URL;try{url=new URL(req.url??'',provider.redirectUrl);}catch{res.writeHead(400);res.end();return;}
      if(req.method!=='GET'||used||req.headers.host!==new URL(provider.redirectUrl).host||url.pathname!=='/qoopia/callback'||
        (req.url?.length??0)>8192||url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==provider.state()||
        url.searchParams.getAll('iss').length!==1||url.searchParams.get('iss')!==provider.issuer){res.writeHead(400);res.end('Invalid OAuth callback.');return;}
      if(url.searchParams.has('error')){used=true;res.writeHead(403);res.end('Connection was not approved.');refuse(new StdioAccessError('CLIENT_AUTH_REFUSED'));return;}
      const value=url.searchParams.get('code');if(!value||value.length>4096||url.searchParams.getAll('code').length!==1){res.writeHead(400);res.end();return;}
      used=true;res.end('Approval received. Return to Qoopia to check completion.');accept(value);
    });
    server.listen(port,'127.0.0.1');await once(server,'listening');
    const redirect='http://127.0.0.1:'+(server.address() as {port:number}).port+'/qoopia/callback';
    const timeout=Math.min(options.timeoutMs??600_000,600_000),expires=Date.now()+timeout;
    provider=new StdioOAuthProvider(folder,binding,redirect,url=>onReady({open_url:url.href,expires_at:expires}));
    abort=()=>{deadline.abort();refuse(new StdioAccessError('CLIENT_AUTH_EXPIRED'));};
    timer=setTimeout(abort,timeout);options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)throw new StdioAccessError('CLIENT_AUTH_EXPIRED');
    const bounded=((input:Request|string|URL,init?:RequestInit)=>(options.request??fetch)(input,{...init,
      signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),deadline.signal])})) as typeof fetch;
    const request=stdioFetch(binding,bounded),args={serverUrl:binding.mcp_url,scope:provider.clientMetadata.scope,
      resourceMetadataUrl:new URL(new URL(binding.mcp_url).origin+'/.well-known/oauth-protected-resource/mcp/c/'+binding.connection_id),fetchFn:request};
    if(await auth(provider,args)==='REDIRECT'){
      const value=await code;
      if(Date.now()>=expires||options.signal?.aborted)throw new StdioAccessError('CLIENT_AUTH_EXPIRED');
      if(await auth(provider,{...args,authorizationCode:value})!=='AUTHORIZED')throw new StdioAccessError('CLIENT_AUTH_REFUSED');
    }
    if(deadline.signal.aborted)throw new StdioAccessError('CLIENT_AUTH_EXPIRED');
    return stdioAuthStatus(root,binding);
  }catch(error){if(deadline.signal.aborted)throw new StdioAccessError('CLIENT_AUTH_EXPIRED');if(error instanceof StdioAccessError)throw error;throw new StdioAccessError('CLIENT_AUTH_REFUSED');}
  finally{if(timer)clearTimeout(timer);if(abort)options.signal?.removeEventListener('abort',abort);server?.closeAllConnections();server?.close();release();}
}
