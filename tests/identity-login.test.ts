import {test,expect,spyOn} from 'bun:test';
import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {loginBroker} from '../src/identity/broker.ts';
import {localIdentityLogin,ownerIdentity,LOGIN_ORIGIN} from '../src/identity/local.ts';
import {issueLocalLogin} from '../src/delivery/local-login.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {checkDashboardAuth,handleDashboardApi} from '../src/dashboard-api.ts';
import {env} from '../src/utils/env.ts';

test('email and Google require the same one-use email proof; logout, restart and re-login preserve the owner',async()=>{
 runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-identity-')),remote=new Database(':memory:');
 db.query("INSERT INTO workspaces(id,name,slug) VALUES ('identity-login','Identity login','identity-login')").run();
 const owner=bootstrapOwner(db,'Identity owner',undefined,'identity-login'),old=process.env.QOOPIA_STANDALONE;
 process.env.QOOPIA_STANDALONE='true';
 const mails:{to:string[];text:string}[]=[];
 let googleEmail='owner@example.com';
 const handler=loginBroker(remote,{origin:LOGIN_ORIGIN,resendKey:'fixture',from:'Qoopia <login@mail.qoopia.ai>',googleClientId:'fixture-client',googleClientSecret:'fixture-secret'},(async(input,init)=>{
  if(String(input)==='https://api.resend.com/emails'){mails.push(JSON.parse(String(init?.body)));return Response.json({id:'sent'});}
  if(String(input)==='https://oauth2.googleapis.com/token'){
   const params=new URLSearchParams(String(init?.body));expect(params.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);return Response.json({access_token:'fixture-access'});
  }
  if(String(input)==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'stable-google-account',email:googleEmail,email_verified:true});
  throw new Error('Unexpected provider call');
 }) as typeof fetch);
 const post=(route:string,body:unknown,origin?:string)=>handler(new Request(LOGIN_ORIGIN+route,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)}),'test-device');
 const transport=(async(input,init)=>handler(new Request(String(input),init),'test-device')) as typeof fetch;
 let local=localIdentityLogin(root,db,transport);
 const jar=new Map<string,string>(),headers=()=>({host:`127.0.0.1:${env.PORT}`,origin:`http://127.0.0.1:${env.PORT}`,cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')});
 const response=()=>{
  let status=0,body='';const out:Record<string,string>={};
  const res={setHeader:(k:string,v:string)=>{out[k]=v;},writeHead:(s:number,h:Record<string,string>)=>{status=s;Object.assign(out,h);},end:(v:string)=>{body=v;}} as unknown as ServerResponse;
  return {res,result:()=>{if(out['set-cookie']){const value=out['set-cookie'].split(';')[0]!,i=value.indexOf('=');jar.set(value.slice(0,i),value.slice(i+1));}return {status,data:JSON.parse(body),headers:out};}};
 };
 const call=async(route:string,body:Record<string,unknown>={})=>{const r=response();await local({method:route?'POST':'GET',headers:headers(),socket:{remoteAddress:'127.0.0.1'}} as IncomingMessage,r.res,route,body);return r.result();};
 const confirm=async()=>{
  const link=mails.at(-1)!.text.match(/https:\/\/[^\s]+/)![0],token=new URL(link).hash.slice(1);
  expect((await handler(new Request(LOGIN_ORIGIN+'/confirm'),'mail-scanner')).status).toBe(200);
  expect((await call('/poll')).data.pending).toBe(true);
  expect((await post('/confirm',{token},'https://hostile.example')).status).toBe(403);
  expect((await post('/confirm',{token},LOGIN_ORIGIN)).status).toBe(200);
  expect((await post('/confirm',{token},LOGIN_ORIGIN)).status).toBe(400);
 };
 const google=async()=>{
  const start=await call('/start',{method:'google'});expect(start.status).toBe(200);
  const redirect=await handler(new Request(start.data.googleUrl),'test-device'),url=new URL(redirect.headers.get('location')!);
  expect(url.searchParams.get('scope')).toBe('openid email');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const callback=LOGIN_ORIGIN+'/google/callback?'+new URLSearchParams({code:'fixture-code',state:url.searchParams.get('state')!});
  expect((await handler(new Request(callback),'test-device')).status).toBe(403);
  const cookie=redirect.headers.get('set-cookie')!.split(';')[0]!;
  expect((await handler(new Request(callback,{headers:{cookie}}),'test-device')).status).toBe(200);
  expect((await handler(new Request(callback,{headers:{cookie}}),'test-device')).status).toBe(403);
 };
 try{
  expect((await call('/start',{method:'email',email:'owner@example.com'})).status).toBe(400);expect(mails).toHaveLength(0);
  expect((await call('/setup',{code:issueLocalLogin(owner.agent_id)})).status).toBe(200);
  expect((await call('/start',{method:'email',email:'Owner@example.com'})).status).toBe(200);
  await confirm();expect((await call('/poll')).status).toBe(200);
  expect(ownerIdentity(root)).toEqual({ownerId:owner.agent_id,email:'owner@example.com'});
  const oldCookie=jar.get('qoopia_dash')!;expect(checkDashboardAuth({headers:headers()} as IncomingMessage)?.agent_id).toBe(owner.agent_id);
  const logout=response();expect(handleDashboardApi({url:'/api/dashboard/logout',method:'POST',headers:headers()} as IncomingMessage,logout.res)).toBe(true);expect(logout.result().status).toBe(200);
  expect(checkDashboardAuth({headers:{cookie:'qoopia_dash='+oldCookie}} as IncomingMessage)).toBeNull();
  local=localIdentityLogin(root,db,transport);jar.clear();
  expect((await call('/start',{method:'email',email:'owner@example.com'})).status).toBe(200);await confirm();expect((await call('/poll')).status).toBe(200);
  expect(ownerIdentity(root)?.ownerId).toBe(owner.agent_id);
  expect((await call('/start',{method:'email',email:'stranger@example.com'})).status).toBe(200);await confirm();expect((await call('/poll')).status).toBe(400);
  expect(ownerIdentity(root)?.email).toBe('owner@example.com');
  await google();await confirm();expect((await call('/poll')).status).toBe(200);expect(ownerIdentity(root)?.googleSub).toBe('stable-google-account');
  googleEmail='renamed@example.com';await google();await confirm();expect((await call('/poll')).status).toBe(200);
  expect(ownerIdentity(root)).toEqual({ownerId:owner.agent_id,email:'renamed@example.com',googleSub:'stable-google-account'});
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('hex');
  const fresh=await(await post('/requests',{method:'email',email:'expiry@example.com',challenge})).json() as {id:string};
  expect((await post('/redeem',{id:fresh.id,verifier:randomBytes(32).toString('base64url')})).status).toBe(410);
  const clock=spyOn(Date,'now').mockReturnValue(Date.now()+601_000);
  try{expect((await post('/redeem',{id:fresh.id,verifier})).status).toBe(410);}finally{clock.mockRestore();}
  expect((db.query("SELECT COUNT(*) AS n FROM workspace_owners WHERE workspace_id='identity-login'").get() as {n:number}).n).toBe(1);
 }finally{remote.close();fs.rmSync(root,{recursive:true,force:true});if(old===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=old;}
});
