import { test,expect,spyOn } from 'bun:test';
import type { IncomingMessage,ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { localOwnerLoginHandler,checkDashboardAuth,renewLocalOwnerSession,ownerIdentityRequestAllowed } from '../src/dashboard-api.ts';
import { localIdentityLogin } from '../src/identity/local.ts';
import { localSessionSecret } from '../src/delivery/local-login.ts';
import { env } from '../src/utils/env.ts';

test('P3 local capability session uses existing owner cookie authority and denies hostile/absent origins and Host',()=>{
 runMigrations();db.query("INSERT INTO workspaces(id,name,slug) VALUES ('p3-login','Login fixture','p3-login')").run();
 const owner=bootstrapOwner(db,'Local login fixture',undefined,'p3-login'),previous=process.env.QOOPIA_STANDALONE;
 process.env.QOOPIA_STANDALONE='true';
 const request=(id:string,headers:Record<string,string>)=>{
  let status=0,body='',out:Record<string,string>={};
  localOwnerLoginHandler({headers,socket:{remoteAddress:'127.0.0.1'}} as IncomingMessage,
   {writeHead:(s:number,h:Record<string,string>)=>{status=s;out=h;},end:(v:string)=>{body=v;}} as unknown as ServerResponse,id);
  return {status,body,headers:out};
 };
 try{
  const headers={host:`127.0.0.1:${env.PORT}`,origin:`http://127.0.0.1:${env.PORT}`};
  const good=request(owner.agent_id,headers);expect(good.status).toBe(200);expect(good.headers['set-cookie']).toContain('HttpOnly');expect(good.headers['set-cookie']).toContain('SameSite=Strict');expect(good.headers['set-cookie']).not.toContain('Secure');expect(good.body).toBe('{"ok":true}');
  const cookieRequest={headers:{...headers,cookie:good.headers['set-cookie']!.split(';')[0]},socket:{remoteAddress:'127.0.0.1'}} as IncomingMessage;
  const now=Date.now(),clock=spyOn(Date,'now').mockReturnValue(now+366*86400000);
  try {
   expect(checkDashboardAuth(cookieRequest)?.agent_id).toBe(owner.agent_id);
   let renewed='';renewLocalOwnerSession(cookieRequest,{setHeader:(_k:string,v:string)=>{renewed=v;}} as unknown as ServerResponse);
   expect(renewed).toContain('Max-Age=31536000');expect(renewed).not.toBe(good.headers['set-cookie']);
  } finally {clock.mockRestore();}
  expect(request(owner.agent_id,{...headers,origin:'http://evil.invalid'}).status).toBe(403);
  expect(request(owner.agent_id,{...headers,host:'evil.invalid'}).status).toBe(403);
  expect(request(owner.agent_id,{host:headers.host}).status).toBe(403);
  expect(request('non-owner',headers).status).toBe(401);
  db.query("UPDATE agents SET principal_kind='agent' WHERE id=?").run(owner.agent_id);
  expect(request(owner.agent_id,headers).status).toBe(401);
  expect(checkDashboardAuth(cookieRequest)).toBeNull();
  db.query("UPDATE agents SET principal_kind='human',session_version=session_version+1 WHERE id=?").run(owner.agent_id);
  expect(checkDashboardAuth(cookieRequest)).toBeNull();
 }finally{if(previous===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=previous;}
});

test('installed session key survives restarts and refuses exposed or linked keys',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-session-'));
 try{
  const key=localSessionSecret(root),file=path.join(root,'config/dashboard-session.key');
  expect(localSessionSecret(root)).toBe(key);expect(key).toMatch(/^[a-f0-9]{64}$/);
  fs.chmodSync(file,0o644);expect(()=>localSessionSecret(root)).toThrow('Unsafe');
  fs.chmodSync(file,0o600);fs.renameSync(file,file+'.original');fs.symlinkSync(file+'.original',file);
  expect(()=>localSessionSecret(root)).toThrow('Links');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('hosted owner login requires explicit enablement, trusted HTTPS and same origin; public setup is refused',async()=>{
 runMigrations();db.query("INSERT INTO workspaces(id,name,slug) VALUES ('hosted-login','Hosted login','hosted-login')").run();
 const owner=bootstrapOwner(db,'Hosted owner',undefined,'hosted-login');
 const previous={standalone:process.env.QOOPIA_STANDALONE,enabled:process.env.QOOPIA_OWNER_LOGIN,url:env.PUBLIC_URL,proxy:env.TRUST_PROXY};
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-hosted-login-'));
 const req={method:'POST',headers:{host:'memory.example.com',origin:'https://memory.example.com','x-forwarded-proto':'https'},socket:{remoteAddress:'127.0.0.1'}} as IncomingMessage;
 let status=0,cookie='';
 const res={setHeader:()=>{},writeHead:(s:number,h:Record<string,string>)=>{status=s;cookie=h['set-cookie']??'';},end:()=>{}} as unknown as ServerResponse;
 try{
  delete process.env.QOOPIA_STANDALONE;delete process.env.QOOPIA_OWNER_LOGIN;
  env.PUBLIC_URL='https://memory.example.com';env.TRUST_PROXY=true;
  expect(ownerIdentityRequestAllowed(req)).toBe(false);
  process.env.QOOPIA_OWNER_LOGIN='true';expect(ownerIdentityRequestAllowed(req)).toBe(true);
  for(const headers of [{...req.headers,origin:'https://evil.example'},{...req.headers,origin:undefined},{...req.headers,host:'evil.example'},{...req.headers,'x-forwarded-proto':'http'}]){
   expect(ownerIdentityRequestAllowed({...req,headers} as IncomingMessage)).toBe(false);
  }
  expect(ownerIdentityRequestAllowed({...req,socket:{remoteAddress:'203.0.113.1'}} as IncomingMessage)).toBe(false);
  env.TRUST_PROXY=false;expect(ownerIdentityRequestAllowed(req)).toBe(false);env.TRUST_PROXY=true;
  localOwnerLoginHandler(req,res,owner.agent_id);expect(status).toBe(200);expect(cookie).toContain('Secure');
  const authenticated={...req,headers:{...req.headers,cookie:cookie.split(';')[0]}} as IncomingMessage;
  const clock=spyOn(Date,'now').mockReturnValue(Date.now()+366*86400000);
  try{expect(checkDashboardAuth(authenticated)?.agent_id).toBe(owner.agent_id);}finally{clock.mockRestore();}
  db.query('UPDATE agents SET session_version=session_version+1 WHERE id=?').run(owner.agent_id);
  expect(checkDashboardAuth(authenticated)).toBeNull();
  await localIdentityLogin(root,db)(req,res,'/setup',{code:'unused'});expect(status).toBe(400);
  expect(fs.existsSync(path.join(root,'config/owner-identity.json'))).toBe(false);
 }finally{
  env.PUBLIC_URL=previous.url;env.TRUST_PROXY=previous.proxy;
  if(previous.standalone===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=previous.standalone;
  if(previous.enabled===undefined)delete process.env.QOOPIA_OWNER_LOGIN;else process.env.QOOPIA_OWNER_LOGIN=previous.enabled;
  fs.rmSync(root,{recursive:true,force:true});
 }
});

test('P3 login form fallback posts the capability and never puts it in a query string',()=>{
 const source=fs.readFileSync(new URL('../src/public/dashboard.html',import.meta.url),'utf8');
 const form=source.match(/<form\b(?=[^>]*\bid="ownerLoginForm")[^>]*>[\s\S]*?<\/form>/)?.[0];
 expect(form).toBeDefined();
 expect(form).toMatch(/\bmethod="post"/);
 expect(form).toMatch(/\baction="\/api\/dashboard\/local-login"/);
 expect(form).toMatch(/<input\b[^>]*\bname="code"/);
});
