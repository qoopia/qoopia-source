import {noAnalytics,type RecordEvent} from '../analytics/events.ts';
import type {Database} from 'bun:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {accounts} from './account.ts';
import {profileView} from './profile-view.ts';
import {newsletter} from './newsletter.ts';
import {ownerPortal,type OwnerOptions} from './owner.ts';

const secret=()=>randomBytes(32).toString('base64url');
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const sessionName='__Host-qoopia_profile',pendingName='__Host-qoopia_profile_pending';
const cookie=(req:Request,name:string)=>req.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)??'';
const setCookie=(name:string,value:string,seconds:number)=>`${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${seconds}`;
type Page=(title:string,content:string,script?:string,status?:number,language?:'en'|'ru')=>Response;
type Call=(route:string,body:unknown,ip:string)=>Promise<Response>;

/** A saved navigation address is not a credential or a grant to somebody else's memory. */
export function dashboardAddress(value:unknown):string {
  if(typeof value!=='string'||value.length>512)throw new Error('INVALID_DASHBOARD');
  let url:URL;try{url=new URL(value);}catch{throw new Error('INVALID_DASHBOARD');}
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||!['/','/dashboard'].includes(url.pathname))throw new Error('INVALID_DASHBOARD');
  // The managed endpoint is an MCP-only edge. It never publishes the dashboard.
  if(/^c-[a-f0-9-]{36}\.qoopia\.ai$/.test(url.hostname)||['qoopia.ai','www.qoopia.ai','auth.qoopia.ai'].includes(url.hostname))throw new Error('INVALID_DASHBOARD');
  return new URL('/dashboard',url.origin).href;
}

export function profilePortal(db:Database,origin:string,page:Page,call:Call,record:RecordEvent=noAnalytics,ownerOptions:OwnerOptions={}) {
  const identify=accounts(db);
  const news=newsletter(db);
  const owner=ownerPortal(db,page,ownerOptions);
  db.exec(`CREATE TABLE IF NOT EXISTS profile_sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_pending(hash TEXT PRIMARY KEY,request_id TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_news_pending(hash TEXT PRIMARY KEY,language TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_dashboards(account_id TEXT PRIMARY KEY,url TEXT NOT NULL);`);
  const cleanup=()=>{
    db.query('DELETE FROM profile_sessions WHERE expires<=?').run(Date.now());
    db.query('DELETE FROM profile_pending WHERE expires<=?').run(Date.now());
    db.query('DELETE FROM profile_news_pending WHERE hash NOT IN (SELECT hash FROM profile_pending)').run();
  };
  const busy=new Set<string>();
  const json=(status:number,body:unknown)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  const current=(req:Request)=>db.query(`SELECT a.id,a.email,d.url FROM profile_sessions s JOIN connection_accounts a ON a.id=s.account_id
    LEFT JOIN profile_dashboards d ON d.account_id=a.id WHERE s.hash=? AND s.expires>?`).get(hash(cookie(req,sessionName)),Date.now()) as {id:string;email:string;url:string|null}|null;
  return {cleanup,handler:async(req:Request,ip:string):Promise<Response>=>{
    cleanup();const url=new URL(req.url),account=current(req);
    if(url.pathname==='/owner'||url.pathname.startsWith('/owner/'))return owner(req,account);
    if(req.method==='GET'&&url.pathname==='/profile'){
      const ru=(url.searchParams.get('lang')??req.headers.get('cookie')?.match(/(?:^|;\s*)qoopia_language=(en|ru)(?:;|$)/)?.[1]??(req.headers.get('accept-language')?.startsWith('ru')?'ru':'en'))==='ru';
      let suggested='';try{suggested=dashboardAddress(url.searchParams.get('dashboard'));}catch{/* Untrusted URL is never reflected without validation. */}
      const preference=account?news.preference(account.id):null;
      return profileView(page,ru,account,suggested,!!db.query('SELECT hash FROM profile_pending WHERE hash=?').get(hash(cookie(req,pendingName))),{subscribed:!!preference?.subscribed&&preference.email===account?.email,owner:!!account&&ownerOptions.accountId===account.id});
    }
    if(req.method!=='POST')return json(404,{error:'NOT_FOUND'});
    if(req.headers.get('origin')!==origin)return json(403,{error:'ORIGIN_REFUSED'});
    if(req.headers.get('content-type')?.split(';')[0]!=='application/json')return json(400,{error:'JSON_REQUIRED'});
    const text=await req.text();if(text.length>2048)return json(413,{error:'REQUEST_TOO_LARGE'});
    try{
      const body=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body))return json(400,{error:'INVALID_REQUEST'});
      if(url.pathname==='/profile/start'){
        if(body.news!==undefined&&typeof body.news!=='boolean')return json(400,{error:'INVALID_REQUEST'});
        const verifier=secret(),pending=secret();
        const response=await call('/requests',{method:body.method,email:body.email,language:body.language==='ru'?'ru':'en',challenge:hash(verifier)},ip);
        const result=await response.json() as {id?:string;error?:string;email?:string;google_url?:string};
        if(!response.ok)return json(response.status,{error:result.error});
        db.query('DELETE FROM profile_pending WHERE hash=?').run(hash(cookie(req,pendingName)));
        db.query('INSERT INTO profile_pending VALUES (?,?,?,?)').run(hash(pending),result.id!,verifier,Date.now()+600_000);
        if(body.news===true)db.query('INSERT INTO profile_news_pending VALUES (?,?)').run(hash(pending),body.language==='ru'?'ru':'en');
        const out=json(200,{email:result.email,google_url:result.google_url});out.headers.set('set-cookie',setCookie(pendingName,pending,600));return out;
      }
      if(url.pathname==='/profile/poll'){
        const key=hash(cookie(req,pendingName));
        const pending=db.query('SELECT p.*,n.language,n.hash IS NOT NULL AS news FROM profile_pending p LEFT JOIN profile_news_pending n ON n.hash=p.hash WHERE p.hash=?').get(key) as {request_id:string;verifier:string;news:number;language:'en'|'ru'}|null;
        if(!pending)return json(410,{error:'LOGIN_EXPIRED'});
        if(busy.has(key))return json(202,{pending:true});
        busy.add(key);
        try{
          const response=await call('/redeem',{id:pending.request_id,verifier:pending.verifier},ip);
          const data=await response.json() as {email?:string;googleSub?:string;pending?:boolean;error?:string};
          if(response.status===202)return json(202,{pending:true});
          db.query('DELETE FROM profile_pending WHERE hash=?').run(key);
          if(!response.ok||!data.email)return json(410,{error:'LOGIN_EXPIRED'});
          const token=secret();
          db.transaction(()=>{
            const id=identify({email:data.email!,googleSub:data.googleSub});
            if(pending.news)news.change({id,email:data.email!},true,pending.language,'signup');
            db.query('DELETE FROM profile_sessions WHERE hash=?').run(hash(cookie(req,sessionName)));
            db.query('INSERT INTO profile_sessions VALUES (?,?,?)').run(hash(token),id,Date.now()+7*86_400_000);
          })();
          record({kind:'profile_login',outcome:'ok'});
          const out=json(200,{ok:true});out.headers.append('set-cookie',setCookie(sessionName,token,7*86400));out.headers.append('set-cookie',setCookie(pendingName,'',0));return out;
        }finally{busy.delete(key);}
      }
      if(!account)return json(401,{error:'SIGN_IN_REQUIRED'});
      if(url.pathname==='/profile/news'){
        if(typeof body.subscribed!=='boolean'||!['en','ru'].includes(body.language))return json(400,{error:'INVALID_REQUEST'});
        news.change(account,body.subscribed,body.language,'profile');
        return json(200,{ok:true,subscribed:body.subscribed});
      }
      if(url.pathname==='/profile/dashboard'){
        if(body.url===null)db.query('DELETE FROM profile_dashboards WHERE account_id=?').run(account.id);
        else db.query('INSERT INTO profile_dashboards VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET url=excluded.url').run(account.id,dashboardAddress(body.url));
        record({kind:'profile_saved',outcome:'ok'});
        return json(200,{ok:true});
      }
      if(url.pathname==='/profile/logout'){
        db.query('DELETE FROM profile_sessions WHERE hash=?').run(hash(cookie(req,sessionName)));
        db.query('DELETE FROM profile_pending WHERE hash=?').run(hash(cookie(req,pendingName)));
        record({kind:'profile_logout',outcome:'ok'});
        const out=json(200,{ok:true});out.headers.append('set-cookie',setCookie(sessionName,'',0));out.headers.append('set-cookie',setCookie(pendingName,'',0));return out;
      }
      return json(404,{error:'NOT_FOUND'});
    }catch(error){return json(400,{error:error instanceof Error&&['INVALID_DASHBOARD','ACCOUNT_CONFLICT'].includes(error.message)?error.message:'INVALID_REQUEST'});}
  }};
}
