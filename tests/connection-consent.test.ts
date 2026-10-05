import {test,expect,spyOn} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {Database} from 'bun:sqlite';import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';import type {AddressInfo} from 'node:net';
import {db} from '../src/db/connection.ts';import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';import {createWorkspace} from '../src/admin/workspaces.ts';
import {connectionAction,connectionRegistrationAuth,publicConnection} from '../src/services/client-connections.ts';
import {registerClient,createConsentTicket,getConsentTicket} from '../src/auth/oauth.ts';
import {loginBroker} from '../src/identity/broker.ts';
import {remoteConnectionConsent} from '../src/identity/connection-consent.ts';
import {durableWrite,privateDirectory} from '../src/utils/fs.ts';import {env} from '../src/utils/env.ts';
import {startHttpServer} from '../src/http.ts';import {authLimiter} from '../src/utils/rate-limit.ts';
import {authenticate} from '../src/auth/middleware.ts';
import {signSession} from '../src/dashboard-session.ts';
import {startMcpEdge} from '../src/delivery/mcp-edge.ts';import http from 'node:http';
import {LOGIN_ORIGIN} from '../src/identity/local.ts';

test('remote owner consent binds browser, account and exact client; real finalize and token exchange grant no dashboard authority',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-remote-consent-')),registry=new Database(':memory:');
  const origin='https://consent.example',loginOrigin='https://auth.example',prior=env.PUBLIC_URL,priorRoot=env.ROOT_DIR;env.PUBLIC_URL=origin;env.ROOT_DIR=root;
  const owner=bootstrapOwner(db,'Remote owner',undefined,createWorkspace({name:'Private remote space',slug:randomUUID()}).id);
  privateDirectory(path.join(root,'config'));const bindingFile=path.join(root,'config/owner-identity.json');
  const binding={ownerId:owner.agent_id,email:'owner@example.test'};durableWrite(bindingFile,JSON.stringify(binding));
  const emails:string[]=[];
  const broker=loginBroker(registry,{origin:loginOrigin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture'},
    (async(_input,init)=>{emails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'sent'});}) as typeof fetch);
  // F-125: the consent page runs on loopback here, so its sign-in belongs to the network the broker
  // sees the installation call from ('synthetic'); a confirmation from anywhere else counts for nothing.
  const network=(async(input,init)=>broker(new Request(String(input),init),'synthetic')) as typeof fetch;
  let handler=remoteConnectionConsent(root,db,network,loginOrigin);
  const server=startHttpServer();if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const make=()=>{
    const connection=(connectionAction(owner.agent_id,{action:'apply',surface:'chatgpt_web',access_mode:'read_write',request_key:randomUUID()}) as any).connection;
    const redirect_uris=['https://chatgpt.com/connector_platform_oauth_redirect'];
    const client=registerClient({client_name:'Synthetic <Client>',redirect_uris},connectionRegistrationAuth(connection.id,redirect_uris));
    const verifier=randomBytes(32).toString('base64url');
    const ticket=createConsentTicket({clientId:client.client_id,workspaceId:owner.workspace_id,redirectUri:client.redirect_uris[0]!,
      codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256',scope:'mcp:read mcp:write',state:'client-state',resource:connection.mcp_url});
    return {connection,client,ticket,verifier};
  };
  const session=async(f:ReturnType<typeof make>,language='en')=>{
    const response=await handler(new Request(origin+'/oauth/consent?'+new URLSearchParams({ticket:f.ticket.id,lang:language})));
    // Real browser form POSTs suppress Origin under no-referrer; keep same-origin
    // submissions verifiable while withholding the consent URL from other sites.
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://chatgpt.com;");
    const cookie=response.headers.get('set-cookie')!;expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict; Path=/oauth/consent');
    let html=await response.text();
    if(process.env.QOOPIA_UX_FIXTURE_DIR){const file=path.join(process.env.QOOPIA_UX_FIXTURE_DIR,'consent-'+language+'.html');if(!fs.existsSync(file))fs.writeFileSync(file,html);}
    expect(html).not.toContain(binding.email);expect(html).not.toContain('Private remote space');
    const current=()=>html.match(/name="nonce" value="([^"]+)"/)?.[1]??'';
    const get=async()=>{const result=await handler(new Request(origin+'/oauth/consent?ticket='+f.ticket.id,{headers:{cookie:cookie.split(';')[0]!}}));html=await result.text();return {result,html};};
    const post=async(action:string,fields:Record<string,string>={},headers:Record<string,string>={})=>{
      const result=await handler(new Request(origin+'/oauth/consent/'+action,{method:'POST',headers:{origin,cookie:cookie.split(';')[0]!,
        'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({ticket:f.ticket.id,nonce:current(),...fields})}));
      html=await result.text();return {result,html};
    };
    return {post,get,nonce:current,cookie:cookie.split(';')[0]!};
  };
  const confirm=async()=>{
    const token=new URL(emails.at(-1)!.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
    const send=(ip:string)=>broker(new Request(loginOrigin+'/confirm',{method:'POST',headers:{origin:loginOrigin,'content-type':'application/json'},body:JSON.stringify({token})}),ip);
    expect((await send('elsewhere')).status).toBe(400);
    expect((await send('synthetic')).status).toBe(200);
  };
  try{
    const first=make(),browser=await session(first,'ru');
    // A Russian phone opens consent without ?lang (ChatGPT redirects to the bare ticket URL): it follows Accept-Language.
    const phone=make(),phoneHtml=await (await handler(new Request(origin+'/oauth/consent?ticket='+phone.ticket.id,{headers:{'accept-language':'ru-RU,ru;q=0.9'}}))).text();
    expect(phoneHtml).toContain('<html lang="ru">');expect(phoneHtml).toContain('Подключение памяти');
    expect((await browser.post('approve')).result.status).toBe(403);await browser.get();
    expect((await browser.post('start',{method:'email',email:binding.email},{origin:'https://attacker.example'})).result.status).toBe(403);
    expect(emails).toHaveLength(0);await browser.get();
    for(const origin of ['null','']){
      expect((await browser.post('start',{method:'email',email:binding.email},{origin})).result.status).toBe(403);
      expect(emails).toHaveLength(0);await browser.get();
    }
    expect((await browser.post('start',{method:'email',email:binding.email},{cookie:'qoopia_dash=owner-cookie'})).result.status).toBe(403);
    expect(emails).toHaveLength(0);await browser.get();
    const oldNonce=browser.nonce(),started=await browser.post('start',{method:'email',email:binding.email});
    expect(started.result.status).toBe(200);expect(started.html).not.toContain('<strong>');expect(started.html).toContain('на этом устройстве');
    expect((await browser.post('check',{nonce:oldNonce})).result.status).toBe(403);await browser.get();
    const notYet=(await browser.post('check')).html;expect(notYet).toContain('на этом устройстве');expect(notYet).toContain('Подтверждение ещё не получено');
    expect(getConsentTicket(first.ticket.id)!.approved_by_agent_id).toBeNull();
    await confirm();const review=await browser.post('check');expect(review.html).toContain('Private remote space');
    expect(review.html).toContain('Synthetic &lt;Client&gt;');expect(review.html).toContain('Чтение и добавление памяти');
    expect(review.html).toContain('<dd>chatgpt.com</dd>');
    expect(getConsentTicket(first.ticket.id)!.approved_by_agent_id).toBeNull();
    const accountCookie=review.result.headers.get('set-cookie')!.split(';')[0]!;
    const another=make();
    const reused=await handler(new Request(origin+'/oauth/consent?ticket='+another.ticket.id,{headers:{cookie:accountCookie}}));
    const reusedHtml=await reused.text();expect(reusedHtml).toContain('Allow this client');expect(emails.filter(e=>e.includes('https://'))).toHaveLength(1);
    expect(getConsentTicket(another.ticket.id)!.approved_by_agent_id).toBeNull();
    const denied=await handler(new Request(origin+'/oauth/consent/deny',{method:'POST',headers:{origin,
      cookie:reused.headers.get('set-cookie')!.split(';')[0]!,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({ticket:another.ticket.id,nonce:reusedHtml.match(/name="nonce" value="([^"]+)"/)![1]!})}));
    expect(denied.status).toBe(303);const deniedTarget=new URL(denied.headers.get('location')!);
    expect(deniedTarget.searchParams.get('error')).toBe('access_denied');
    expect(deniedTarget.searchParams.get('iss')).toBe(origin+'/oauth/c/'+another.connection.id);
    expect(deniedTarget.searchParams.get('state')).toBe('client-state');expect(deniedTarget.searchParams.has('code')).toBe(false);
    const approvalNonce=browser.nonce();
    const allowed=await browser.post('approve');expect(allowed.result.status).toBe(303);
    const agent=publicConnection(first.connection.id).agent_id;
    expect(getConsentTicket(first.ticket.id)!.approved_by_agent_id).toBe(agent);expect(agent).not.toBe(owner.agent_id);
    const target=new URL(allowed.result.headers.get('location')!);expect(target.origin+target.pathname).toBe(first.client.redirect_uris[0]!);
    expect(target.searchParams.get('iss')).toBe(origin+'/oauth/c/'+first.connection.id);expect(target.searchParams.get('code')).toMatch(/^qc_/);
    // F-076: the ticket id alone yields no code once approved.
    authLimiter.resetForTests();const final=await fetch(base+'/oauth/authorize/finalize?ticket='+first.ticket.id,{redirect:'manual'});
    expect(final.status).toBe(400);expect(final.headers.get('location')).toBeNull();
    const replay=await browser.post('approve',{nonce:approvalNonce});expect(replay.result.status).toBe(303);expect(replay.result.headers.get('location')).toBe(target.href);
    expect((await browser.get()).result.headers.get('location')).toBe(target.href);
    expect((await handler(new Request(origin+'/oauth/consent?ticket='+first.ticket.id))).status).toBe(403);
    const exchange=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:first.client.client_id,
      code:target.searchParams.get('code')!,code_verifier:first.verifier,redirect_uri:first.client.redirect_uris[0]!,resource:first.connection.mcp_url})});
    expect(exchange.status).toBe(200);const token=(await exchange.json() as any).access_token;
    expect(authenticate(new Request(first.connection.mcp_url,{headers:{authorization:'Bearer '+token}}))?.agent_id).toBe(agent);
    expect((await fetch(base+'/api/dashboard/connection-setup',{headers:{authorization:'Bearer '+token}})).status).toBe(401);
    expect((await browser.post('approve')).result.status).toBe(403);

    // A live human dashboard session needs consent, not another email login.
    const direct=make(),dashboardCookie='qoopia_dash='+signSession(owner.agent_id,(db.query('SELECT session_version FROM agents WHERE id=?').get(owner.agent_id) as {session_version:number}).session_version);
    const reviewDirect=await fetch(base+'/api/dashboard/oauth-consent?ticket='+direct.ticket.id,{headers:{cookie:dashboardCookie},redirect:'manual'});
    expect(reviewDirect.status).toBe(200);const directHtml=await reviewDirect.text();expect(directHtml).toContain('Authorize access');
    // read_write grants mcp:write, which never includes note_update or note_delete [F-302].
    const scopes=/<ul class="scope-list">[\s\S]*?<\/ul>/.exec(directHtml)![0];expect(scopes).toContain('Add new memory records');expect(scopes).not.toMatch(/update/i);
    // The Russian page must not promise the edits that English rules out.
    const ruReview=await (await fetch(base+'/api/dashboard/oauth-consent?ticket='+make().ticket.id+'&lang=ru',{headers:{cookie:dashboardCookie},redirect:'manual'})).text();
    const ruScopes=/<ul class="scope-list">[\s\S]*?<\/ul>/.exec(ruReview)![0];expect(ruScopes).toContain('Добавлять новые записи');expect(ruScopes).not.toMatch(/обновлять/i);
    expect(getConsentTicket(direct.ticket.id)!.approved_by_agent_id).toBeNull();
    const directApprove=await fetch(base+'/api/dashboard/oauth-consent/approve',{method:'POST',headers:{cookie:dashboardCookie,origin,
      'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket:direct.ticket.id,nonce:directHtml.match(/name="nonce" value="([^"]+)"/)![1]!}),redirect:'manual'});
    expect(directApprove.status).toBe(302);expect(getConsentTicket(direct.ticket.id)!.approved_by_agent_id).toBe(publicConnection(direct.connection.id).agent_id);
    const strangerCookie='qoopia_dash='+signSession(publicConnection(first.connection.id).agent_id,0);
    const forbidden=make();
    expect((await fetch(base+'/api/dashboard/oauth-consent?ticket='+forbidden.ticket.id,{headers:{cookie:strangerCookie}})).status).toBe(403);
    const fallback=await fetch(base+'/api/dashboard/oauth-consent?ticket='+forbidden.ticket.id+'&session_check=1',{redirect:'manual'});
    expect(fallback.status).toBe(302);expect(fallback.headers.get('location')).toBe(origin+'/oauth/consent?ticket='+forbidden.ticket.id);
    // A tunnel install reaches /oauth/authorize only through the edge, which publishes no dashboard route:
    // the account consent page must be the first hop, not a REMOTE_CONSENT_REQUIRED refusal.
    const tunneled=make(),edge=startMcpEdge({publicOrigin:origin+'/',upstreamPort:(server.address() as AddressInfo).port});
    if(!edge.listening)await once(edge,'listening');
    const authorizeQuery=new URLSearchParams({client_id:tunneled.client.client_id,redirect_uri:tunneled.client.redirect_uris[0]!,response_type:'code',
      code_challenge:createHash('sha256').update(tunneled.verifier).digest('base64url'),code_challenge_method:'S256',state:'s',resource:tunneled.connection.mcp_url});
    const viaEdge=await new Promise<http.IncomingMessage>((resolve,reject)=>http.get({port:(edge.address() as AddressInfo).port,path:'/oauth/authorize?'+authorizeQuery,
      headers:{host:new URL(origin).host}},r=>{r.resume();resolve(r);}).on('error',reject));
    expect(viaEdge.statusCode).toBe(302);
    const edgeTarget=new URL(viaEdge.headers.location!);expect(edgeTarget.origin+edgeTarget.pathname).toBe(origin+'/oauth/consent');
    expect(getConsentTicket(edgeTarget.searchParams.get('ticket')!)?.resource).toBe(tunneled.connection.mcp_url);
    const sameOrigin=await fetch(base+'/oauth/authorize?'+authorizeQuery,{redirect:'manual'});
    expect(new URL(sameOrigin.headers.get('location')!).pathname).toBe('/api/dashboard/oauth-consent');
    edge.close();
    expect(emails.filter(e=>e.includes('https://'))).toHaveLength(1);

    const wrong=make(),stranger=await session(wrong);
    await stranger.post('start',{method:'email',email:'stranger@example.test'});await confirm();
    expect((await stranger.post('check')).html).toContain('WRONG_ACCOUNT');await stranger.get();
    expect((await stranger.post('approve')).result.status).toBe(403);expect(getConsentTicket(wrong.ticket.id)!.approved_by_agent_id).toBeNull();

    const drift=make(),changed=await session(drift);
    await changed.post('start',{method:'email',email:binding.email});await confirm();await changed.post('check');
    durableWrite(bindingFile,JSON.stringify({...binding,email:'replacement@example.test'}));
    expect((await changed.post('approve')).result.status).toBe(403);expect(getConsentTicket(drift.ticket.id)!.approved_by_agent_id).toBeNull();
    durableWrite(bindingFile,JSON.stringify(binding));

    const revoked=make(),revokedBrowser=await session(revoked);
    await revokedBrowser.post('start',{method:'email',email:binding.email});await confirm();await revokedBrowser.post('check');
    connectionAction(owner.agent_id,{action:'disconnect',id:revoked.connection.id});
    expect((await revokedBrowser.post('approve')).result.status).not.toBe(303);expect(getConsentTicket(revoked.ticket.id)!.approved_by_agent_id).toBeNull();

    // Restart is an independent fault scenario, not a test of the broker's already-covered email quota.
    registry.run('DELETE FROM login_limits');
    const restart=make(),interrupted=await session(restart);
    await interrupted.post('start',{method:'email',email:binding.email});handler=remoteConnectionConsent(root,db,network,loginOrigin);
    expect((await interrupted.post('check')).result.status).toBe(403);
    const resumed=await session(restart);await resumed.post('start',{method:'email',email:binding.email});await confirm();await resumed.post('check');
    db.query('UPDATE agents SET session_version=session_version+1 WHERE id=?').run(owner.agent_id);
    expect((await resumed.post('approve')).result.status).toBe(403);expect(getConsentTicket(restart.ticket.id)!.approved_by_agent_id).toBeNull();
    const expiry=make(),expired=await session(expiry),clock=spyOn(Date,'now').mockReturnValue(Date.now()+601_000);
    try{expect((await expired.post('start',{method:'email',email:binding.email})).result.status).toBe(403);}finally{clock.mockRestore();}
  }finally{env.PUBLIC_URL=prior;env.ROOT_DIR=priorRoot;server.closeAllConnections();server.close();registry.close();fs.rmSync(root,{recursive:true,force:true});}
});

// The sign-in service accepts the emailed link only from the network the consent started on. Behind the
// tunnel edge the server's client key is `edge:<address>`; sending that label made every confirmation
// from the owner's own browser fail with "Open this link on the device where you started signing in".
test('tunnel consent binds the sign-in to the browser address, not the edge rate-limit label',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-edge-consent-'));
  const origin='https://edge-consent.example',prior=env.PUBLIC_URL,priorRoot=env.ROOT_DIR,realFetch=globalThis.fetch;env.PUBLIC_URL=origin;env.ROOT_DIR=root;
  const owner=bootstrapOwner(db,'Edge owner',undefined,createWorkspace({name:'Edge space',slug:randomUUID()}).id);
  privateDirectory(path.join(root,'config'));durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}));
  const sent:Record<string,unknown>[]=[];
  globalThis.fetch=(async(input:Request|string|URL,init?:RequestInit)=>{
    if(!String(input).startsWith(LOGIN_ORIGIN))return realFetch(input,init);
    sent.push(JSON.parse(String(init?.body)));return Response.json({id:randomBytes(32).toString('base64url')});
  }) as typeof fetch;
  const server=startHttpServer();if(!server.listening)await once(server,'listening');
  const edge=startMcpEdge({publicOrigin:origin,upstreamPort:(server.address() as AddressInfo).port});if(!edge.listening)await once(edge,'listening');
  const viaEdge=(url:string,method='GET',headers:Record<string,string>={},body?:string)=>new Promise<{status:number;headers:http.IncomingHttpHeaders;body:string}>((resolve,reject)=>{
    const r=http.request({port:(edge.address() as AddressInfo).port,path:url,method,headers:{host:new URL(origin).host,'cf-connecting-ip':'203.0.113.7',...headers}},x=>{
      let text='';x.on('data',d=>text+=d);x.on('end',()=>resolve({status:x.statusCode!,headers:x.headers,body:text}));});r.on('error',reject);r.end(body);});
  try{
    authLimiter.resetForTests();
    const connection=(connectionAction(owner.agent_id,{action:'apply',surface:'chatgpt_web',access_mode:'read_write',request_key:randomUUID()}) as any).connection;
    const redirect_uris=['https://chatgpt.com/connector_platform_oauth_redirect'];
    const client=registerClient({client_name:'ChatGPT',redirect_uris},connectionRegistrationAuth(connection.id,redirect_uris));
    const authorize=await viaEdge('/oauth/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:redirect_uris[0]!,response_type:'code',
      code_challenge:createHash('sha256').update('v'.repeat(43)).digest('base64url'),code_challenge_method:'S256',state:'s',resource:connection.mcp_url}));
    const consent=new URL(authorize.headers.location!),page=await viaEdge(consent.pathname+consent.search);
    const ticket=consent.searchParams.get('ticket')!,cookie=String(page.headers['set-cookie']).split(';')[0]!;
    const started=await viaEdge('/oauth/consent/start','POST',{origin,cookie,'content-type':'application/x-www-form-urlencoded'},
      new URLSearchParams({ticket,nonce:page.body.match(/name="nonce" value="([^"]+)"/)![1]!,method:'email',email:'owner@example.test'}).toString());
    expect(started.status).toBe(200);expect(sent).toHaveLength(1);
    expect(sent[0]!.bind).toBe('network');expect(sent[0]!.starter_ip).toBe('203.0.113.7');
  }finally{globalThis.fetch=realFetch;env.PUBLIC_URL=prior;env.ROOT_DIR=priorRoot;edge.closeAllConnections();edge.close();server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('a consent page reached through the tunnel edge speaks the browser language and confirms from that browser',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-edge-consent-')),registry=new Database(':memory:');
  const origin='https://c-edge.example',prior=env.PUBLIC_URL,priorRoot=env.ROOT_DIR;env.PUBLIC_URL=origin;env.ROOT_DIR=root;
  const owner=bootstrapOwner(db,'Edge owner',undefined,createWorkspace({name:'Edge space',slug:randomUUID()}).id);
  privateDirectory(path.join(root,'config'));durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}));
  const emails:string[]=[],realFetch=globalThis.fetch;
  const broker=loginBroker(registry,{origin:'https://auth.qoopia.ai',resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture'},
    (async(_input,init)=>{emails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'sent'});}) as typeof fetch);
  // The broker sees the installation's own address; the owner's phone reaches the edge through Cloudflare.
  const spy=spyOn(globalThis,'fetch').mockImplementation((async(input:string|URL|Request,init?:RequestInit)=>String(input).startsWith('https://auth.qoopia.ai')?
    broker(new Request(String(input),init),'198.51.100.9'):realFetch(input,init)) as typeof fetch);
  const server=startHttpServer();if(!server.listening)await once(server,'listening');
  const edge=startMcpEdge({publicOrigin:origin,upstreamPort:(server.address() as AddressInfo).port});if(!edge.listening)await once(edge,'listening');
  try{
    authLimiter.resetForTests();
    const connection=(connectionAction(owner.agent_id,{action:'apply',surface:'chatgpt_web',access_mode:'read_write',request_key:randomUUID()}) as any).connection;
    const redirect_uris=['https://chatgpt.com/connector_platform_oauth_redirect'];
    const client=registerClient({client_name:'ChatGPT',redirect_uris},connectionRegistrationAuth(connection.id,redirect_uris));
    const ticket=createConsentTicket({clientId:client.client_id,workspaceId:owner.workspace_id,redirectUri:redirect_uris[0]!,
      codeChallenge:createHash('sha256').update('v'.repeat(43)).digest('base64url'),codeChallengeMethod:'S256',scope:'mcp:read mcp:write',state:'s',resource:connection.mcp_url});
    const phone=(route:string,init:RequestInit={})=>realFetch('http://127.0.0.1:'+(edge.address() as AddressInfo).port+route,{...init,redirect:'manual',
      headers:{...init.headers as Record<string,string>,host:new URL(origin).host,'cf-connecting-ip':'203.0.113.7','accept-language':'ru-RU,ru;q=0.9,en;q=0.8'}});
    const page=await phone('/oauth/consent?ticket='+ticket.id),cookie=page.headers.get('set-cookie')!.split(';')[0]!,html=await page.text();
    // A Russian browser reads the consent page in Russian without picking the language first.
    expect(html).toContain('<html lang="ru">');expect(html).toContain('Подключение памяти');
    const nonce=html.match(/name="nonce" value="([^"]+)"/)![1]!;
    const started=await phone('/oauth/consent/start',{method:'POST',headers:{origin,cookie,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({ticket:ticket.id,nonce,method:'email',email:'owner@example.test'}).toString()});
    expect(started.status).toBe(200);
    const token=new URL(emails.at(-1)!.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
    const confirmed=await broker(new Request('https://auth.qoopia.ai/confirm',{method:'POST',headers:{origin:'https://auth.qoopia.ai','content-type':'application/json'},body:JSON.stringify({token})}),'203.0.113.7');
    expect(confirmed.status).toBe(200);
    // Once the broker's hourly email allowance is spent, the page names the way out instead of "reopen this page".
    let last=started,text=await started.text();
    for(let i=0;i<3&&last.status===200;i++){
      last=await phone('/oauth/consent/start',{method:'POST',headers:{origin,cookie,'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({ticket:ticket.id,nonce:text.match(/name="nonce" value="([^"]+)"/)![1]!,method:'email',email:'owner@example.test'}).toString()});
      text=await last.text();
    }
    expect(last.status).toBe(429);expect(text).toContain('TOO_MANY_SIGN_INS');expect(text).toContain('Google');
  }finally{spy.mockRestore();edge.close();env.PUBLIC_URL=prior;env.ROOT_DIR=priorRoot;server.closeAllConnections();server.close();registry.close();fs.rmSync(root,{recursive:true,force:true});}
});
