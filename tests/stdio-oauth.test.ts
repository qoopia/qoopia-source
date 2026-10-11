import {test,expect} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {privateDirectory,durableWrite} from '../src/utils/fs.ts';
import {authorizeStdioClient,stdioAuthStatus,stdioFolder,StdioOAuthProvider,stdioFetch,lockStdioCredentials,type StdioBinding} from '../src/delivery/stdio-oauth.ts';
import {db} from '../src/db/connection.ts';import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';import {bootstrapOwner} from '../src/auth/pairings.ts';
import {connectionAction} from '../src/services/client-connections.ts';import {startHttpServer} from '../src/http.ts';
import {env} from '../src/utils/env.ts';import {authLimiter,dashboardLimiter} from '../src/utils/rate-limit.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('adapter sign-in has a hard deadline, releases its OS lock, and does not store tokens after cancellation',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-stdio-deadline-'))),id=randomUUID();
  const binding:StdioBinding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface:'claude_desktop',access_mode:'read',mcp_url:'https://fixture.example/mcp/c/'+id};
  const request=(async(_input:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    if(init?.signal?.aborted)reject(new Error('aborted'));
    else init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  })) as typeof fetch;
  try{
    await expect(authorizeStdioClient(root,binding,()=>{throw new Error('Unexpected browser');},{timeoutMs:10,request})).rejects.toThrow('CLIENT_AUTH_EXPIRED');
    expect(stdioAuthStatus(root,binding).credentials_present).toBe(false);
    const release=lockStdioCredentials(stdioFolder(root,binding));release();
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('local adapter OAuth uses real scoped discovery/PKCE, validates callback state/issuer, stores private tokens and remains unverified until a client call',async()=>{
  runMigrations();authLimiter.resetForTests();dashboardLimiter.resetForTests();
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-stdio-auth-'))),slug=randomUUID();
  const owner=bootstrapOwner(db,'Synthetic adapter owner',undefined,createWorkspace({name:'Synthetic adapter fixture',slug}).id);
  const server=startHttpServer();await new Promise<void>(r=>server.listening?r():server.once('listening',r));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const previous={url:env.PUBLIC_URL,issuer:env.OAUTH_ISSUER,origins:env.DASHBOARD_ALLOWED_ORIGINS};
  env.PUBLIC_URL=base;env.OAUTH_ISSUER=base;env.DASHBOARD_ALLOWED_ORIGINS=[base];
  let client:Client|undefined;
  try{
    const connection=(connectionAction(owner.agent_id,{action:'apply',surface:'codex',access_mode:'read_write',request_key:slug}) as any).connection;
    // This test qualifies the adapter protocol only; the Desktop wizard is a separate acceptance path.
    const binding:StdioBinding={format:'qoopia-client-connection/1',connection_id:connection.id,workspace_id:owner.workspace_id,
      surface:'claude_desktop',access_mode:'read_write',mcp_url:connection.mcp_url};
    let ready!:(url:string)=>void;const opened=new Promise<string>(r=>ready=r);
    const pending=authorizeStdioClient(root,binding,step=>ready(step.open_url),{timeoutMs:5000});
    const url=await Promise.race([opened,pending.then(()=>{throw new Error('Expected explicit human consent');})]);
    const folder=stdioFolder(root,binding),callback=new URL(new URL(url).searchParams.get('redirect_uri')!);
    callback.searchParams.set('state','wrong');callback.searchParams.set('iss',base+'/oauth/c/'+binding.connection_id);callback.searchParams.set('code','wrong');
    expect((await fetch(callback)).status).toBe(400);
    expect(()=>lockStdioCredentials(folder)).toThrow('CLIENT_AUTH_BUSY');
    const started=await fetch(url,{redirect:'manual'});expect(started.status).toBe(302);
    const consentUrl=started.headers.get('location')!,ticket=new URL(consentUrl).searchParams.get('ticket')!;
    const login=await fetch(base+'/api/dashboard/login',{method:'POST',headers:{authorization:'Bearer '+owner.api_key,origin:base}});
    const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const consent=await fetch(consentUrl,{headers:{cookie}});expect(consent.status).toBe(200);
    const nonce=(await consent.text()).match(/name="nonce" value="([^"]+)"/)![1]!;
    const approval=await fetch(base+'/api/dashboard/oauth-consent/approve',{method:'POST',redirect:'manual',headers:{cookie,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,nonce})});expect(approval.status).toBe(302);
    const approved=new URL(approval.headers.get('location')!),foreign=new URL(approved);foreign.searchParams.set('iss','https://foreign.example');
    expect((await fetch(foreign)).status).toBe(400);expect((await fetch(approved)).status).toBe(200);
    const result=await pending;expect(result.verified).toBe(false);expect(result.code).toBe('CLIENT_CALL_REQUIRED');
    const stored=fs.readFileSync(path.join(folder,'oauth.json'),'utf8');expect(stored).not.toContain('verifier');
    expect(fs.statSync(path.join(folder,'oauth.json')).mode&0o777).toBe(0o600);
    expect(JSON.stringify(stdioAuthStatus(root,binding))).not.toContain(JSON.parse(stored).tokens.access_token);
    expect(()=>new StdioOAuthProvider(folder,{...binding,workspace_id:'foreign'})).toThrow('CLIENT_AUTH_REFUSED');
    const provider=new StdioOAuthProvider(folder,binding);
    await expect(stdioFetch(binding)('https://foreign.example/oauth/token',{method:'POST',body:'fixture'})).rejects.toThrow('CLIENT_AUTH_REFUSED');
    client=new Client({name:'Synthetic local stdio adapter qualification',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(binding.mcp_url),{authProvider:provider,fetch:stdioFetch(binding)}));
    const proof=connectionAction(owner.agent_id,{action:'verify',id:connection.id}) as any;
    const verification=await client.callTool({name:'connection_verify',arguments:{connection_id:connection.id,challenge:proof.prompt.match(/challenge "([^"]+)"/)[1]}});
    expect(verification.isError).not.toBe(true);
    expect((connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0].code).toBe('CLIENT_CALL_VERIFIED');
    await client.close();
    const helper=path.join(root,'adapter.ts');fs.writeFileSync(helper,
      'import {serveStdioClient} from '+JSON.stringify(path.resolve('src/delivery/stdio-client.ts'))+';\nawait serveStdioClient('+JSON.stringify(root)+','+JSON.stringify(binding)+');\n');
    client=new Client({name:'Synthetic real stdio process',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[helper],env:{NODE_ENV:'test',QOOPIA_ROOT:root,HOME:root,PATH:process.env.PATH!},stderr:'pipe'}));
    // A second Desktop process may still hold the shared OAuth lock during discovery.
    // Keep the request alive until that process finishes, without replaying an upstream call.
    const unlock=lockStdioCredentials(folder);
    const discovery=client.listTools().then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try{await new Promise<void>(resolve=>setTimeout(resolve,100));}finally{unlock();}
    const discovered=await discovery;
    expect(discovered.error).toBeUndefined();
    expect(discovered.value?.tools.some(t=>t.name==='note_create')).toBe(true);
    expect((await client.listTools()).tools.some(t=>t.name==='note_create')).toBe(true);
    const input={text:'Synthetic stdio process fixture',type:'memory',idempotency_key:'stdio-fixture'};
    const write=await client.callTool({name:'note_create',arguments:input}),again=await client.callTool({name:'note_create',arguments:input});
    expect(write.isError).not.toBe(true);
    const note=JSON.parse((write.content as any)[0].text);expect(JSON.parse((again.content as any)[0].text).id).toBe(note.id);
    expect(JSON.stringify(await client.callTool({name:'note_get',arguments:{id:note.id}}))).toContain(input.text);
    // Force normal SDK refresh without changing the server's token validity or weakening verification.
    const privateFile=path.join(folder,'oauth.json'),expired=JSON.parse(fs.readFileSync(privateFile,'utf8'));expired.tokens.access_token='expired-fixture-token';fs.writeFileSync(privateFile,JSON.stringify(expired));
    expect(JSON.stringify(await client.callTool({name:'note_get',arguments:{id:note.id}}))).toContain(input.text);
    connectionAction(owner.agent_id,{action:'disconnect',id:connection.id});
    await expect(client.callTool({name:'note_get',arguments:{id:note.id}})).rejects.toThrow('Check this connection in Qoopia');
  }finally{await client?.close();env.PUBLIC_URL=previous.url;env.OAUTH_ISSUER=previous.issuer;env.DASHBOARD_ALLOWED_ORIGINS=previous.origins;
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}
});

// GHSA-6qxp-vccf-f47h: stored credentials are bound to the pinned issuer and never leave the selected installation.
function issuerFixture(metadata:Record<string,unknown>={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-stdio-issuer-'))),id=randomUUID(),origin='https://fixture.example';
  const binding:StdioBinding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface:'claude_desktop',access_mode:'read',mcp_url:origin+'/mcp/c/'+id};
  const folder=stdioFolder(root,binding),issuer=origin+'/oauth/c/'+id,seen:string[]=[],bodies:string[]=[];
  const write=(client:object,tokens:object)=>{privateDirectory(folder);durableWrite(path.join(folder,'oauth.json'),JSON.stringify({format:'qoopia-stdio-oauth/1',binding,redirect_uri:'http://127.0.0.1:1/qoopia/callback',client,tokens}));};
  const request=(async(input:Request|string|URL,init?:RequestInit)=>{
    const url=new URL(input instanceof Request?input.url:String(input));seen.push(url.href);
    if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return Response.json({resource:binding.mcp_url,authorization_servers:[issuer]});
    if(url.pathname.startsWith('/.well-known/'))return Response.json({issuer,authorization_endpoint:origin+'/oauth/authorize?connection='+id,token_endpoint:origin+'/oauth/token',
      registration_endpoint:origin+'/oauth/register?connection='+id,response_types_supported:['code'],code_challenge_methods_supported:['S256'],...metadata});
    if(url.href===origin+'/oauth/token'){bodies.push(String(init?.body));return Response.json({access_token:'fresh-fixture',token_type:'Bearer',refresh_token:'rotated-fixture',scope:'mcp:read'});}
    return new Response(null,{status:404});
  }) as typeof fetch;
  const refresh=async()=>auth(new StdioOAuthProvider(folder,binding),{serverUrl:binding.mcp_url,scope:'mcp:read',fetchFn:stdioFetch(binding,request),
    resourceMetadataUrl:new URL(origin+'/.well-known/oauth-protected-resource/mcp/c/'+id)});
  return {root,binding,folder,issuer,seen,bodies,write,refresh,stored:()=>JSON.parse(fs.readFileSync(path.join(folder,'oauth.json'),'utf8'))};
}
const legacyTokens={access_token:'stale-fixture',token_type:'Bearer',refresh_token:'legacy-fixture',scope:'mcp:read'};

test('metadata naming a foreign issuer or token endpoint is refused before any request reaches the foreign origin',async()=>{
  for(const metadata of [{issuer:'https://foreign.example/oauth/c/x'},{token_endpoint:'https://foreign.example/oauth/token'}]){
    const f=issuerFixture(metadata);
    try{
      f.write({client_id:'fixture-client'},legacyTokens);
      await expect(f.refresh()).rejects.toThrow('CLIENT_AUTH_REFUSED');
      expect(f.seen.length).toBeGreaterThan(0);expect(f.seen.filter(u=>new URL(u).origin!=='https://fixture.example')).toEqual([]);
      expect(f.bodies).toEqual([]);expect(f.stored().tokens.refresh_token).toBe('legacy-fixture');
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});

test('legacy credentials without issuer migrate to the pinned issuer and refresh without a new sign-in',async()=>{
  const f=issuerFixture();
  try{
    f.write({client_id:'fixture-client'},legacyTokens);
    const provider=new StdioOAuthProvider(f.folder,f.binding);
    expect(provider.tokens()?.issuer).toBe(f.issuer);expect(provider.clientInformation()?.issuer).toBe(f.issuer);
    expect(await f.refresh()).toBe('AUTHORIZED');
    expect(f.bodies.length).toBe(1);expect(new URLSearchParams(f.bodies[0]).get('refresh_token')).toBe('legacy-fixture');
    const stored=f.stored();
    expect(stored.tokens).toMatchObject({access_token:'fresh-fixture',refresh_token:'rotated-fixture',issuer:f.issuer});
    expect(stored.client).toEqual({client_id:'fixture-client',issuer:f.issuer});
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('credentials stamped for another issuer are refused, on load and on save',async()=>{
  const f=issuerFixture(),foreign='https://fixture.example/oauth/c/'+randomUUID();
  try{
    for(const [client,tokens] of [[{client_id:'fixture-client'},{...legacyTokens,issuer:foreign}],[{client_id:'fixture-client',issuer:foreign},legacyTokens]] as const){
      f.write(client,tokens);
      expect(()=>new StdioOAuthProvider(f.folder,f.binding)).toThrow('CLIENT_AUTH_REFUSED');
      expect(()=>stdioAuthStatus(f.root,f.binding)).toThrow('CLIENT_AUTH_REFUSED');
      await expect(f.refresh()).rejects.toThrow('CLIENT_AUTH_REFUSED');
    }
    expect(f.seen).toEqual([]);
    f.write({client_id:'fixture-client'},legacyTokens);const provider=new StdioOAuthProvider(f.folder,f.binding);
    expect(()=>provider.saveTokens({...legacyTokens,issuer:foreign})).toThrow('CLIENT_AUTH_REFUSED');
    expect(()=>provider.saveClientInformation({client_id:'fixture-client',issuer:foreign})).toThrow('CLIENT_AUTH_REFUSED');
    expect(f.stored().tokens.issuer).toBeUndefined();
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
