import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {loginBroker} from '../src/identity/broker.ts';
import {accountHandoff} from '../src/identity/account-handoff.ts';
import {localIdentityLogin,ownerIdentity,LOGIN_ORIGIN} from '../src/identity/local.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {db} from '../src/db/connection.ts';
import {env} from '../src/utils/env.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {checkDashboardAuth} from '../src/dashboard-api.ts';

test('account continuation uses the existing workspace owner and browser, rejects a different identity or rotated session',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-account-')),remote=new Database(':memory:');
  db.query("INSERT INTO workspaces(id,name,slug) VALUES ('account-login','Account login','account-login')").run();
  const previous={enabled:process.env.QOOPIA_OWNER_LOGIN,url:env.PUBLIC_URL,proxy:env.TRUST_PROXY};
  process.env.QOOPIA_OWNER_LOGIN='true';env.PUBLIC_URL='https://workspace.example.test';env.TRUST_PROXY=true;
  const owner=bootstrapOwner(db,'Account owner',undefined,'account-login');
  fs.mkdirSync(path.join(root,'config'),{mode:0o700});
  fs.writeFileSync(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}),{mode:0o600});
  const broker=loginBroker(remote,{origin:LOGIN_ORIGIN,resendKey:'test',from:'test@example.test',googleClientId:'test',googleClientSecret:'test'},(async()=>{throw Error('No email should be sent');}) as typeof fetch);
  const local=localIdentityLogin(root,db,(async(input,init)=>broker(new Request(String(input),init),'test')) as typeof fetch);
  const handoff=accountHandoff(remote),jar=new Map<string,string>();
  const call=async(route:string,body:Record<string,unknown>={},cookies=jar)=>{
    let status=0,result='';const headers:Record<string,string>={};
    const response={setHeader:(k:string,v:string)=>headers[k]=v,writeHead:(s:number,h:Record<string,string>)=>{status=s;Object.assign(headers,h);},end:(b:string)=>result=b} as unknown as ServerResponse;
    const cookie=[...cookies].map(([k,v])=>k+'='+v).join('; ');
    await local({method:'POST',headers:{host:'workspace.example.test',origin:'https://workspace.example.test','x-forwarded-proto':'https',cookie},socket:{remoteAddress:'127.0.0.1'}} as unknown as IncomingMessage,response,route,body);
    if(headers['set-cookie']){const c=headers['set-cookie'].split(';')[0]!,i=c.indexOf('=');cookies.set(c.slice(0,i),c.slice(i+1));}
    return {status,body:JSON.parse(result),headers};
  };
  const begin=async(email='owner@example.test')=>{
    const r=await call('/start',{method:'account'});expect(r.status).toBe(200);
    const id=new URL(r.body.accountUrl).searchParams.get('request')!;
    const redirect=handoff.authorize(id,{email,url:'https://workspace.example.test/dashboard'});
    return new URLSearchParams(new URL(redirect).hash.slice(1)).get('account_code')!;
  };
  try{
    const code=await begin();expect((await call('/poll')).body).toEqual({pending:true});
    expect((await call('/poll',{accountCode:code},new Map())).status).toBe(400);
    expect((await call('/poll',{accountCode:code})).status).toBe(200);
    expect(checkDashboardAuth({headers:{cookie:'qoopia_dash='+jar.get('qoopia_dash')}} as IncomingMessage)?.agent_id).toBe(owner.agent_id);
    expect((await call('/poll',{accountCode:code})).status).toBe(400);
    jar.clear();expect((await call('/poll',{accountCode:await begin('stranger@example.test')})).status).toBe(400);expect(jar.has('qoopia_dash')).toBe(false);
    expect(ownerIdentity(root)).toEqual({ownerId:owner.agent_id,email:'owner@example.test'});
    const rotated=await begin();db.query('UPDATE agents SET session_version=session_version+1 WHERE id=?').run(owner.agent_id);
    expect((await call('/poll',{accountCode:rotated})).status).toBe(400);expect(jar.has('qoopia_dash')).toBe(false);
    expect((db.query("SELECT COUNT(*) n FROM workspace_owners WHERE workspace_id='account-login'").get() as {n:number}).n).toBe(1);
  }finally{env.PUBLIC_URL=previous.url;env.TRUST_PROXY=previous.proxy;if(previous.enabled===undefined)delete process.env.QOOPIA_OWNER_LOGIN;else process.env.QOOPIA_OWNER_LOGIN=previous.enabled;remote.close();fs.rmSync(root,{recursive:true,force:true});}
});
