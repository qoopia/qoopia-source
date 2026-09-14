// Isolated browser fixture. Never deployed; no real mail, credentials or user data.
import {githubFixture} from './owner-github-fixture.ts';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loginBroker} from '../../src/identity/broker.ts';
import {accounts} from '../../src/identity/account.ts';
import {newsletter} from '../../src/identity/newsletter.ts';
const root=mkdtempSync(join(tmpdir(),'qoopia-news-browser-')),db=new Database(':memory:'),origin='https://auth.example.test';
const identify=accounts(db),owner=identify({email:'owner@example.test'});
identify({email:'new.reader@example.test'});identify({email:'long.email.for.mobile.layout@example.test'});
const file=join(root,'latest.json');writeFileSync(file,JSON.stringify({github_ecosystem:githubFixture(),github_history:[],generated_at:new Date().toISOString(),latest:['mac.dmg','linux.tar.gz'].map((file,i)=>({source:'github_releases',metric:'asset_downloads',value:i+3,observed_at:new Date().toISOString(),dimensions:{tag:'fixture',file}})),event_daily:[{day:'2026-09-14',source:'server',kind:'auth_request',events:3},{day:'2026-09-14',source:'server',kind:'profile_login',events:2}],source_runs:['github_releases','account_service','first_party_events','github_ecosystem'].map(source=>({source,status:'ok',finished_at:new Date().toISOString()}))}));
const mail:string[]=[];
const handler=loginBroker(db,{origin,resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture',owner:{accountId:owner,analyticsFile:file,releaseTag:'fixture'}},(async(_url,init)=>{mail.push(JSON.parse(String(init?.body)).text);return Response.json({id:'fixture'});}) as typeof fetch);
db.query('INSERT INTO profile_sessions VALUES (?,?,?)').run(createHash('sha256').update('synthetic-owner').digest('hex'),owner,Date.now()+3600000);
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const url=new URL(req.url);
 if(url.pathname==='/__fixture/mail')return Response.json({mail:mail.at(-1)});
 if(url.pathname==='/__fixture/unsubscribe'){const store=newsletter(db);store.change({id:owner,email:'owner@example.test'},true,'ru','profile');return Response.json({path:'/news/unsubscribe?lang=ru&token='+store.token(store.preference(owner)!)});}
 const headers=new Headers(req.headers);headers.set('host',new URL(origin).host);if(headers.get('origin')===url.origin)headers.set('origin',origin);
 return handler(new Request(origin+url.pathname+url.search,{method:req.method,headers,...(req.method!=='GET'&&req.method!=='HEAD'?{body:await req.arrayBuffer()}:{})}),'fixture');
}});
console.log(server.port);
process.on('SIGTERM',()=>{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});process.exit(0);});
