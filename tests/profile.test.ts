import {test,expect,spyOn} from 'bun:test';
import {Database} from 'bun:sqlite';
import {loginBroker} from '../src/identity/broker.ts';
import {dashboardAddress} from '../src/identity/profile.ts';
import {accounts} from '../src/identity/account.ts';

test('profile uses confirmed identity, binds redemption to the initiating browser, isolates saved dashboards and revokes sessions',async()=>{
  const db=new Database(':memory:'),origin='https://auth.example.test',mails:string[]=[];
  const config={origin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture'};
  const provider=(async(_input,init)=>{mails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'fixture'});}) as typeof fetch;
  let handler=loginBroker(db,config,provider);
  const jar:Record<string,string>={};
  const call=async(path:string,body?:unknown,cookies=jar,requestOrigin=origin)=>{
    const result=await handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '),...(body===undefined?{}:{origin:requestOrigin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),'test');
    for(const value of result.headers.getSetCookie()){const [key,...rest]=value.split(';')[0]!.split('=');cookies[key!]=rest.join('=');}
    return result;
  };
  const login=async(email:string,cookies:Record<string,string>)=>{
    expect((await call('/profile/start',{method:'email',email},cookies)).status).toBe(200);
    expect((await call('/profile/poll',{},cookies)).status).toBe(202);
    const token=new URL(mails.at(-1)!.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
    expect((await call('/confirm',{token},{},'https://evil.test')).status).toBe(403);
    expect((await call('/confirm',{token},{})).status).toBe(200);
    expect((await call('/profile/poll',{},{})).status).toBe(410);
    const result=await call('/profile/poll',{},cookies);expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Path=/');
    expect((await call('/profile/poll',{},cookies)).status).toBe(410);
  };
  try{
    expect((await call('/profile/dashboard',{url:'https://private.example.test'})).status).toBe(401);
    expect((await call('/profile/start',{method:'email',email:'owner@example.test'},{},'')).status).toBe(403);
    const existing=accounts(db)({email:'owner@example.test'});
    await login('Owner@example.test',jar);
    expect((db.query('SELECT COUNT(*) n FROM connection_accounts').get() as {n:number}).n).toBe(1);
    const html=await(await call('/profile?lang=ru')).text();expect(html).toContain('owner@example.test');expect(html).toContain('Мой дашборд');
    expect((await call('/profile/dashboard',{url:'https://memory.example.test'},jar,'https://evil.test')).status).toBe(403);
    expect((await call('/profile/dashboard',{url:'https://memory.example.test'})).status).toBe(200);
    expect(db.query('SELECT url FROM profile_dashboards WHERE account_id=?').get(existing)).toEqual({url:'https://memory.example.test/dashboard'});
    handler=loginBroker(db,config,provider); // Profile and session survive service restart.
    expect(await(await call('/profile')).text()).toContain('id="open-dashboard"');
    const other:Record<string,string>={};await login('other@example.test',other);
    const stranger=await(await call('/profile',undefined,other)).text();expect(stranger).not.toContain('https://memory.example.test');expect(stranger).not.toContain('owner@example.test');
    expect((await call('/profile/dashboard',{url:null},other)).status).toBe(200);
    expect(await(await call('/profile')).text()).toContain('https://memory.example.test/dashboard');
    const old={...jar};expect((await call('/profile/logout',{})).status).toBe(200);
    expect(await(await call('/profile',undefined,old)).text()).not.toContain('owner@example.test');
    const clock=spyOn(Date,'now').mockReturnValue(Date.now()+8*86400000);
    try{expect(await(await call('/profile',undefined,other)).text()).not.toContain('other@example.test');}finally{clock.mockRestore();}
    expect((await call('/profile?dashboard=javascript:alert(1)')).status).toBe(200);
    expect(await(await call('/profile?dashboard=javascript:alert(1)')).text()).not.toContain('javascript:alert');
  }finally{db.close();}
});

test('dashboard addresses reject credentials, agent routes and executable or token-bearing links',()=>{
  expect(dashboardAddress('https://my.example/')).toBe('https://my.example/dashboard');
  expect(dashboardAddress('http://127.0.0.1:63655/dashboard')).toBe('http://127.0.0.1:63655/dashboard');
  for(const value of ['javascript:alert(1)','data:text/html,x','//evil.test','http://remote.test','https://u:p@my.test','https://my.test/mcp','https://my.test/dashboard?token=secret','https://my.test/dashboard#secret','https://auth.qoopia.ai','https://c-11111111-1111-1111-1111-111111111111.qoopia.ai',null,{}])expect(()=>dashboardAddress(value)).toThrow('INVALID_DASHBOARD');
});

test('the news form shows only localized messages, never a raw network or parse exception',async()=>{
  const {profileView}=await import('../src/identity/profile-view.ts');
  for(const ru of [false,true]) {
    const html=profileView((_title,_content,script)=>script??'',ru,{email:'owner@example.com',url:null},'',false,{subscribed:true}) as string;
    expect(html).not.toContain('textContent=e.message');
    const M=JSON.parse(html.match(/const M=(\{.*?\}),status=/s)![1]!),known=new Function('M','return '+html.match(/const known=(e=>.*?),show=/s)![1])(M);
    for(const raw of ['Failed to fetch','The operation timed out.','Unexpected token < in JSON at position 0'])expect(known(new TypeError(raw))).toBe(M.failed);
    expect(known(new Error(M.limit))).toBe(M.limit);
    expect(M.failed).toBe(ru?'Не удалось завершить действие. Попробуйте ещё раз.':'Could not complete the action. Please try again.');
    expect(html).toContain('finally{button.disabled=false;}');
  }
});
