// Isolated browser acceptance: real auth/session code, synthetic owner and no email delivery.
import '../setup.ts';
import {Database} from 'bun:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {loginBroker} from '../../src/identity/broker.ts';
import {localIdentityLogin,LOGIN_ORIGIN} from '../../src/identity/local.ts';
import {accounts} from '../../src/identity/account.ts';
import {bootstrapOwner} from '../../src/auth/pairings.ts';
import {db} from '../../src/db/connection.ts';
import {runMigrations} from '../../src/db/migrate.ts';
import {handleDashboardApi,ownerIdentityRequestAllowed} from '../../src/dashboard-api.ts';
import {env} from '../../src/utils/env.ts';
const origin='https://workspace.example.test';
process.env.QOOPIA_OWNER_LOGIN='true';env.PUBLIC_URL=origin;env.TRUST_PROXY=true;
runMigrations();db.query("INSERT INTO workspaces(id,name,slug) VALUES ('phone-fixture','Phone fixture','phone-fixture')").run();
const owner=bootstrapOwner(db,'Synthetic owner',undefined,'phone-fixture'),root=process.env.QOOPIA_ROOT!;
mkdirSync(join(root,'config'),{recursive:true,mode:0o700});writeFileSync(join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'phone@example.test'}),{mode:0o600});
const auth=new Database(':memory:'),mails:string[]=[];
const broker=loginBroker(auth,{origin:LOGIN_ORIGIN,resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture'},(async(_u,init)=>{mails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'fixture'});}) as typeof fetch);
const account=accounts(auth)({email:'phone@example.test'});auth.query('INSERT INTO profile_dashboards VALUES (?,?)').run(account,origin+'/dashboard');
const local=localIdentityLogin(root,db,(async(input,init)=>broker(new Request(String(input),init),'local-fixture')) as typeof fetch);
Bun.serve({hostname:'127.0.0.1',port:18973,async fetch(incoming){
  if(new URL(incoming.url).pathname==='/fixture-mail')return Response.json({count:mails.length,url:mails.at(-1)?.match(/https:\/\/[^\s]+/)?.[0]});
  const original=incoming.headers.get('x-fixture-url');if(!original)return new Response('fixture ready');
  const url=new URL(original),headers=new Headers(incoming.headers);headers.delete('x-fixture-url');headers.set('host',url.host);
  const body=['GET','HEAD'].includes(incoming.method)?undefined:await incoming.text();
  const req=new Request(original,{method:incoming.method,headers,body});
  if(url.pathname.startsWith('/brand/')){const file=Bun.file(join('src/public',url.pathname));return new Response(file);}
  if(url.origin===LOGIN_ORIGIN)return broker(req,'browser-fixture');
  if(url.origin!==origin)return new Response('No external requests permitted', {status:403});
  if(url.pathname==='/dashboard')return new Response(Bun.file('src/public/dashboard.html'));
  return new Promise<Response>((resolve)=>{
    let status=200;const out=new Headers();const res={setHeader:(k:string,v:string)=>out.set(k,v),writeHead:(s:number,h:Record<string,string>)=>{status=s;for(const [k,v] of Object.entries(h))out.set(k,v);},end:(b:string)=>resolve(new Response(b??null,{status,headers:out}))} as unknown as ServerResponse;
    const node={method:req.method,url:url.pathname+url.search,headers:{...Object.fromEntries(headers),'x-forwarded-proto':'https'},socket:{remoteAddress:'127.0.0.1'}} as unknown as IncomingMessage;
    if(url.pathname.startsWith('/api/dashboard/identity')){
      if(!ownerIdentityRequestAllowed(node,req.method!=='GET')){resolve(new Response('denied',{status:403}));return;}
      void local(node,res,url.pathname.slice('/api/dashboard/identity'.length),body?JSON.parse(body):{});return;
    }
    if(!handleDashboardApi(node,res))resolve(new Response('not found',{status:404}));
  });
}});
console.log('Isolated app-entry fixture ready on 127.0.0.1:18973');
