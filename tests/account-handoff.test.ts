import {test,expect,spyOn} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {loginBroker} from '../src/identity/broker.ts';
import {mobileDashboard} from '../src/identity/account-handoff.ts';

test('app login continues into only the saved workspace; a browser-delivered one-use code and server verifier are both required',async()=>{
  const db=new Database(':memory:'),origin='https://auth.example.test',mails:string[]=[];
  const handler=loginBroker(db,{origin,resendKey:'test',from:'test@example.test',googleClientId:'test',googleClientSecret:'test'},(async(_url,init)=>{mails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'test'});}) as typeof fetch);
  const jar:Record<string,string>={};
  const call=async(path:string,body?:unknown,cookies=jar,requestOrigin=origin)=>{
    const response=await handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '),...(body===undefined?{}:{origin:requestOrigin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),'handoff-test');
    for(const value of response.headers.getSetCookie()){const [key,...rest]=value.split(';')[0]!.split('=');cookies[key!]=rest.join('=');}return response;
  };
  const start=async(dashboard='https://workspace.example.test/dashboard')=>{
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('hex');
    const r=await call('/requests',{method:'account',challenge,dashboard});expect(r.status).toBe(201);
    return {...await r.json() as {id:string;account_url:string},verifier};
  };
  try{
    const empty=await(await call('/profile?app=ios&lang=ru')).text();expect(empty).toContain('Вход в Qoopia');expect(empty).not.toContain('My dashboard');expect(empty).not.toContain('Новости Qoopia');
    await call('/profile/start',{method:'email',email:'owner@example.test'});
    const token=new URL(mails[0]!.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
    await call('/confirm',{token});expect((await call('/profile/poll',{})).status).toBe(200);
    await call('/profile/dashboard',{url:'https://workspace.example.test/dashboard'});
    const entry=await(await call('/profile?app=ios')).text();expect(entry).toContain('location.replace("https://workspace.example.test/dashboard?signin=account")');expect(entry).not.toContain('Open on iPhone');
    const flow=await start();
    expect((await call('/profile/authorize',{request:flow.id},{})).status).toBe(401);
    expect((await call('/profile/authorize',{request:flow.id},jar,'https://evil.test')).status).toBe(403);
    const other=await start('https://other.example.test/dashboard');expect((await call('/profile/authorize',{request:other.id})).status).toBe(400);
    const authorized=await(await call('/profile/authorize',{request:flow.id})).json() as {url:string};
    const url=new URL(authorized.url);expect(url.origin).toBe('https://workspace.example.test');expect(url.search).toBe('?signin=complete');
    const code=new URLSearchParams(url.hash.slice(1)).get('account_code');expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Opening an attacker-created authorization URL does not let its creator poll for the identity.
    expect(await(await call('/redeem',{id:flow.id,verifier:flow.verifier})).json()).toEqual({pending:true});
    expect((await call('/redeem',{id:flow.id,verifier:randomBytes(32).toString('base64url'),account_code:code})).ok).toBe(false);
    expect((await call('/redeem',{id:flow.id,verifier:flow.verifier,account_code:'x'.repeat(43)})).ok).toBe(false);
    // A code delivered into another browser/attempt cannot sign that browser in.
    expect((await call('/redeem',{id:other.id,verifier:other.verifier,account_code:code})).ok).toBe(false);
    expect(await(await call('/redeem',{id:flow.id,verifier:flow.verifier,account_code:code})).json()).toEqual({email:'owner@example.test'});
    expect((await call('/redeem',{id:flow.id,verifier:flow.verifier,account_code:code})).status).toBe(410);
    expect(mails).toHaveLength(1); // No second email or model credential transfer.
    const expired=await start(),clock=spyOn(Date,'now').mockReturnValue(Date.now()+601000);
    try{expect((await call('/profile?app=ios&request='+expired.id)).status).toBe(410);expect((await call('/redeem',{id:expired.id,verifier:expired.verifier,account_code:code})).status).toBe(410);}finally{clock.mockRestore();}
    await call('/profile/logout',{});expect((await call('/profile/authorize',{request:other.id})).status).toBe(401);
  }finally{db.close();}
});

test('phone continuation rejects local, managed-only, credential and executable destinations',()=>{
  expect(mobileDashboard('https://workspace.example.test')).toBe('https://workspace.example.test/dashboard');
  for(const url of ['http://localhost','https://localhost','https://127.0.0.1','https://[::1]','https://c-abc.qoopia.ai','https://auth.qoopia.ai','https://u:p@private.test','https://private.test/dashboard#secret','https://private.test/dashboard?token=secret','javascript:alert(1)','https://private.test/mcp'])expect(mobileDashboard(url)).toBeNull();
});
