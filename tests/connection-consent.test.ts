import {test,expect,spyOn} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {Database} from 'bun:sqlite';import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';import type {AddressInfo} from 'node:net';
import {db} from '../src/db/connection.ts';import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';import {createWorkspace} from '../src/admin/workspaces.ts';
import {connectionAction,connectionRegistrationAuth} from '../src/services/client-connections.ts';
import {registerClient,createConsentTicket,getConsentTicket} from '../src/auth/oauth.ts';
import {loginBroker} from '../src/identity/broker.ts';
import {remoteConnectionConsent} from '../src/identity/connection-consent.ts';
import {durableWrite,privateDirectory} from '../src/delivery/files.ts';import {env} from '../src/utils/env.ts';
import {startHttpServer} from '../src/http.ts';import {authLimiter} from '../src/utils/rate-limit.ts';
import {authenticate} from '../src/auth/middleware.ts';

test('remote owner consent binds browser, account and exact client; real finalize and token exchange grant no dashboard authority',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-remote-consent-')),registry=new Database(':memory:');
  const origin='https://consent.example',loginOrigin='https://auth.example',prior=env.PUBLIC_URL;env.PUBLIC_URL=origin;
  const owner=bootstrapOwner(db,'Remote owner',undefined,createWorkspace({name:'Private remote space',slug:randomUUID()}).id);
  privateDirectory(path.join(root,'config'));const bindingFile=path.join(root,'config/owner-identity.json');
  const binding={ownerId:owner.agent_id,email:'owner@example.test'};durableWrite(bindingFile,JSON.stringify(binding));
  const emails:string[]=[];
  const broker=loginBroker(registry,{origin:loginOrigin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture'},
    (async(_input,init)=>{emails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'sent'});}) as typeof fetch);
  const network=(async(input,init)=>broker(new Request(String(input),init),'synthetic')) as typeof fetch;
  let handler=remoteConnectionConsent(root,db,network,loginOrigin);
  const server=startHttpServer();if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const make=()=>{
    const connection=(connectionAction(owner.agent_id,{action:'apply',surface:'chatgpt_web',access_mode:'read_write',request_key:randomUUID()}) as any).connection;
    const client=registerClient({client_name:'Synthetic <Client>',redirect_uris:['https://client.example/callback']},connectionRegistrationAuth(connection.id));
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
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://client.example;");
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
    expect((await broker(new Request(loginOrigin+'/confirm',{method:'POST',headers:{origin:loginOrigin,'content-type':'application/json'},body:JSON.stringify({token})}),'browser')).status).toBe(200);
  };
  try{
    const first=make(),browser=await session(first,'ru');
    expect((await browser.post('approve')).result.status).toBe(403);await browser.get();
    expect((await browser.post('start',{method:'email',email:binding.email},{origin:'https://attacker.example'})).result.status).toBe(403);
    expect(emails).toHaveLength(0);await browser.get();
    for(const origin of ['null','']){
      expect((await browser.post('start',{method:'email',email:binding.email},{origin})).result.status).toBe(403);
      expect(emails).toHaveLength(0);await browser.get();
    }
    expect((await browser.post('start',{method:'email',email:binding.email},{cookie:'qoopia_dash=owner-cookie'})).result.status).toBe(403);
    expect(emails).toHaveLength(0);await browser.get();
    const oldNonce=browser.nonce();expect((await browser.post('start',{method:'email',email:binding.email})).result.status).toBe(200);
    expect((await browser.post('check',{nonce:oldNonce})).result.status).toBe(403);await browser.get();
    expect((await browser.post('check')).html).toContain('подтверждения');
    expect(getConsentTicket(first.ticket.id)!.approved_by_agent_id).toBeNull();
    await confirm();const review=await browser.post('check');expect(review.html).toContain('Private remote space');
    expect(review.html).toContain('Synthetic &lt;Client&gt;');expect(review.html).toContain('Чтение и запись памяти');
    expect(getConsentTicket(first.ticket.id)!.approved_by_agent_id).toBeNull();
    const accountCookie=review.result.headers.get('set-cookie')!.split(';')[0]!;
    const another=make();
    const reused=await handler(new Request(origin+'/oauth/consent?ticket='+another.ticket.id,{headers:{cookie:accountCookie}}));
    const reusedHtml=await reused.text();expect(reusedHtml).toContain('Allow this client');expect(emails).toHaveLength(1);
    expect(getConsentTicket(another.ticket.id)!.approved_by_agent_id).toBeNull();
    const denied=await handler(new Request(origin+'/oauth/consent/deny',{method:'POST',headers:{origin,
      cookie:reused.headers.get('set-cookie')!.split(';')[0]!,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({ticket:another.ticket.id,nonce:reusedHtml.match(/name="nonce" value="([^"]+)"/)![1]!})}));
    expect(denied.status).toBe(303);const deniedTarget=new URL(denied.headers.get('location')!);
    expect(deniedTarget.searchParams.get('error')).toBe('access_denied');
    expect(deniedTarget.searchParams.get('iss')).toBe(origin+'/oauth/c/'+another.connection.id);
    expect(deniedTarget.searchParams.get('state')).toBe('client-state');expect(deniedTarget.searchParams.has('code')).toBe(false);
    const allowed=await browser.post('approve');expect(allowed.result.status).toBe(303);
    const agent=connectionRegistrationAuth(first.connection.id).agent_id;
    expect(getConsentTicket(first.ticket.id)!.approved_by_agent_id).toBe(agent);expect(agent).not.toBe(owner.agent_id);
    authLimiter.resetForTests();const final=await fetch(base+'/oauth/authorize/finalize?ticket='+first.ticket.id,{redirect:'manual'});
    expect(final.status).toBe(302);const target=new URL(final.headers.get('location')!);expect(target.searchParams.get('iss')).toBe(origin+'/oauth/c/'+first.connection.id);
    const exchange=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:first.client.client_id,
      code:target.searchParams.get('code')!,code_verifier:first.verifier,redirect_uri:first.client.redirect_uris[0]!,resource:first.connection.mcp_url})});
    expect(exchange.status).toBe(200);const token=(await exchange.json() as any).access_token;
    expect(authenticate(new Request(first.connection.mcp_url,{headers:{authorization:'Bearer '+token}}))?.agent_id).toBe(agent);
    expect((await fetch(base+'/api/dashboard/connection-setup',{headers:{authorization:'Bearer '+token}})).status).toBe(401);
    expect((await browser.post('approve')).result.status).toBe(410);

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
  }finally{env.PUBLIC_URL=prior;server.closeAllConnections();server.close();registry.close();fs.rmSync(root,{recursive:true,force:true});}
});
