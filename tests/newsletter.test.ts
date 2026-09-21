import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loginBroker} from '../src/identity/broker.ts';
import {accounts} from '../src/identity/account.ts';
import {newsletter,NEWS_CONSENT_VERSION,newsMessage} from '../src/identity/newsletter.ts';
import {prepareNews,sendNews} from '../src/identity/news-sender.ts';

test('news consent requires confirmed identity, stays optional, survives restart, and owner data is isolated',async()=>{
 const db=new Database(':memory:'),origin='https://auth.example.test',mails:string[]=[];
 const identify=accounts(db),ownerId=identify({email:'owner@example.test'}),otherId=identify({email:'other@example.test'});
 const config={origin,resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture',owner:{accountId:ownerId,releaseTag:'fixture'}};
 const provider=(async(_url,init)=>{mails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'fixture'});}) as typeof fetch;
 let handler=loginBroker(db,config,provider);const jar:Record<string,string>={};
 async function call(path:string,body?:unknown,cookies=jar,from=origin){
  const r=await handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '),origin:from,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),'fixture');
  for(const value of r.headers.getSetCookie()){const [k,...v]=value.split(';')[0]!.split('=');cookies[k!]=v.join('=');}return r;
 }
 try{
  const empty=await(await call('/profile?lang=ru')).text();expect(empty).toContain('id="signup-news" type="checkbox">');
  expect((await call('/profile/news',{subscribed:true,language:'ru'})).status).toBe(401);
  expect((await call('/owner')).status).toBe(401);
  expect((await call('/profile/start',{method:'email',email:'owner@example.test',news:'yes'})).status).toBe(400);
  expect((await call('/profile/start',{method:'email',email:'owner@example.test',news:true,language:'ru'})).status).toBe(200);
  expect(newsletter(db).preference(ownerId)).toBeNull();
  const token=new URL(mails.at(-1)!.match(/https:\/\/\S+/)![0]).hash.slice(1);
  expect((await call('/confirm',{token})).status).toBe(200);expect((await call('/profile/poll',{})).status).toBe(200);
  expect(newsletter(db).preference(ownerId)?.subscribed).toBe(1);
  expect(db.query('SELECT source,text_version,language FROM news_consents').get()).toEqual({source:'signup',text_version:NEWS_CONSENT_VERSION,language:'ru'});
  expect(db.query('SELECT login_count FROM account_activity WHERE account_id=?').get(ownerId)).toEqual({login_count:1});
  expect((await call('/profile/news',{subscribed:false,language:'ru'},jar,'https://evil.test')).status).toBe(403);
  handler=loginBroker(db,config,provider);
  expect(await(await call('/profile?lang=ru')).text()).toContain('Панель владельца');
  const panel=await call('/owner');expect(panel.status).toBe(200);expect(panel.headers.get('cache-control')).toBe('no-store');
  const html=await panel.text();expect(html).toContain('other@example.test');expect(html).toContain('Сбор недоступен');expect(html).not.toContain('fixture@example.test');
  const otherToken='fixture-other-session';db.query('INSERT INTO profile_sessions VALUES (?,?,?)').run(createHash('sha256').update(otherToken).digest('hex'),otherId,Date.now()+10000);
  const forbidden=await call('/owner',undefined,{'__Host-qoopia_profile':otherToken});expect(forbidden.status).toBe(403);expect(await forbidden.text()).not.toContain('owner@example.test');
  expect((await call('/profile/news',{subscribed:false,language:'ru',account_id:otherId})).status).toBe(200);
  expect(newsletter(db).preference(ownerId)?.subscribed).toBe(0);expect(newsletter(db).preference(otherId)).toBeNull();
  expect((await call('/profile/logout',{})).status).toBe(200);expect((await call('/owner')).status).toBe(401);
 }finally{db.close();}
});

test('unsubscribe resists forged links and mail scanners, and an old link cannot cancel renewed consent',async()=>{
 const db=new Database(':memory:'),id=accounts(db)({email:'reader@example.test'}),store=newsletter(db),account={id,email:'reader@example.test'};
 const origin='https://auth.example.test',handler=loginBroker(db,{origin,resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture'});
 const req=(token:string,method='GET')=>handler(new Request(origin+'/news/unsubscribe?token='+token,{method,headers:{'content-type':'application/x-www-form-urlencoded'},...(method==='POST'?{body:'List-Unsubscribe=One-Click'}:{})}),'fixture');
 try{
  store.change(account,true,'ru','profile');const token=store.token(store.preference(id)!);
  expect((await req(token)).status).toBe(200);expect(store.preference(id)?.subscribed).toBe(1);
  await req(token.slice(0,-1)+'!','POST');expect(store.preference(id)?.subscribed).toBe(1);
  await req(token,'POST');expect(store.preference(id)?.subscribed).toBe(0);
  await req(token,'POST');expect((db.query('SELECT count(*) n FROM news_consents').get() as {n:number}).n).toBe(2);
  store.change(account,true,'ru','profile');await req(token,'POST');expect(store.preference(id)?.subscribed).toBe(1);
  expect(store.resolve(token)).toBeNull();
  const message=newsMessage({subject:'<Subject>',body:'<script>private</script>',language:'ru'},'https://auth.example.test/news/unsubscribe?token=fixture','Fixture address');
  expect(message.html).not.toContain('<script>');expect(message.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');expect(message.html).toContain('cid:qoopia-brand');expect(message.html).toContain('Manrope');expect(message.html).not.toContain('IBM Plex');
 }finally{db.close();}
});

test('newsletter sending is explicit, suppresses opt-outs, records acceptance and does not resend uncertain attempts',async()=>{
 const db=new Database(':memory:'),identify=accounts(db),id=identify({email:'reader@example.test'}),store=newsletter(db),account={id,email:'reader@example.test'};
 const config={origin:'https://auth.example.test',from:'Qoopia <fixture@example.test>',postalAddress:'Fixture address',resendKey:'fixture'};
 let sends=0;const payloads:Record<string,unknown>[]=[];
 const provider=(async(_url,init)=>{sends++;payloads.push(JSON.parse(String(init?.body)));return Response.json({id:'provider-fixture'});}) as typeof fetch;
 try{
  store.change(account,true,'ru','profile');const campaign=prepareNews(db,'Новости','Полезные инструкции.','ru');
  await expect(sendNews(db,campaign,{...config,postalAddress:''},provider)).rejects.toThrow('SENDER_DETAILS_REQUIRED');expect(sends).toBe(0);
  store.change(account,false,'ru','profile');expect((await sendNews(db,campaign,config,provider)).accepted).toBe(0);
  store.change(account,true,'ru','profile');expect((await sendNews(db,campaign,config,provider)).accepted).toBe(1);
  expect(payloads[0]!.to).toEqual(['reader@example.test']);expect(String(payloads[0]!.text)).toContain('Отписаться');
  await sendNews(db,campaign,config,provider);expect(sends).toBe(1);
  const uncertain=prepareNews(db,'Следующий релиз','Содержание','ru');
  const timeout=(async()=>{sends++;throw new Error('network timeout');}) as typeof fetch;
  expect((await sendNews(db,uncertain,config,timeout)).uncertain).toBe(1);
  await sendNews(db,uncertain,config,provider);expect(sends).toBe(2);
  expect(db.query('SELECT status FROM news_deliveries WHERE campaign_id=?').get(uncertain)).toEqual({status:'uncertain'});
 }finally{db.close();}
});

test('owner page uses a bounded current snapshot and escapes private values',async()=>{
 const root=mkdtempSync(join(tmpdir(),'qoopia-owner-')),db=new Database(':memory:');
 try{
  const id=accounts(db)({email:'<owner>@example.test'}),token='owner-fixture';
  const file=join(root,'latest.json');writeFileSync(file,JSON.stringify({generated_at:new Date().toISOString(),latest:[{source:'github_releases',metric:'asset_downloads',value:7,observed_at:new Date().toISOString(),dimensions:{tag:'current',file:'mac.dmg'}}],event_daily:[],source_runs:['github_releases','account_service','first_party_events'].map(source=>({source,status:'ok',finished_at:new Date().toISOString()}))}));
  const origin='https://auth.example.test',handler=loginBroker(db,{origin,resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture',owner:{accountId:id,analyticsFile:file,releaseTag:'current'}});
  db.query('INSERT INTO profile_sessions VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+10000);
  const r=await handler(new Request(origin+'/owner',{headers:{cookie:'__Host-qoopia_profile='+token}}),'fixture'),html=await r.text();
  expect(r.status).toBe(200);expect(html).toContain('Данные свежие');expect(html).toContain('macOS Apple Silicon');expect(html).toContain('&lt;owner&gt;');expect(html).not.toContain('<owner>');
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
