import {persistentAnalytics,browserEvent,noAnalytics,type RecordEvent} from '../analytics/events.ts';
import {readFileSync,openSync,closeSync,fstatSync,constants} from 'node:fs';
import {assetPath} from '../utils/assets.ts';
import {brandAsset,brandHead,brandLockup} from '../brand.ts';
import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {bridgeRelay} from '../bridges/relay.ts';
import {MAX_RPC} from '../bridges/protocol.ts';
import {deviceRegistry, type DeviceRegistryOptions} from './device-registry.ts';
import {cloudflareTunnels} from './cloudflare.ts';
import {profilePortal} from './profile.ts';
import {accounts} from './account.ts';
import {newsletter,unsubscribePage} from './newsletter.ts';
import type {OwnerOptions} from './owner.ts';
import {confirmationMail,confirmationView,loginLanguage,type LoginLanguage} from './messages.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const lifetime = 10 * 60_000;
export function loginEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || /[\x00-\x1f\x7f]/.test(value) || !/^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(value)) throw new Error('Enter a valid email address');
  return value.toLowerCase();
}
export type LoginIdentity = {email: string; googleSub?: string};
type Flow = {language:LoginLanguage;id:string;challenge:string;expires:number;email:string|null;google_sub:string|null;state:string|null;pkce:string|null;mail_token:string|null;confirmed:number;device_peer:string|null};
type Config = {owner?:OwnerOptions;origin:string;resendKey:string;from:string;googleClientId:string;googleClientSecret:string;devices?:DeviceRegistryOptions;recordEvent?:RecordEvent;browserWrite?:(raw:unknown)=>boolean};

/** Separate sign-in service: it never receives workspace content or model credentials. */
export function loginBroker(db: Database, config: Config, request: typeof fetch = fetch) {
  const origin = new URL(config.origin).origin;
  const record:RecordEvent=event=>{try{(config.recordEvent??noAnalytics)(event);}catch{/* Analytics cannot interrupt account operations. */}};
  if (!origin.startsWith('https://')) throw new Error('The sign-in service requires HTTPS');
  db.exec(`CREATE TABLE IF NOT EXISTS login_requests (
    id TEXT PRIMARY KEY, challenge TEXT NOT NULL, expires INTEGER NOT NULL,
    email TEXT, google_sub TEXT, state TEXT UNIQUE, pkce TEXT, mail_token TEXT UNIQUE, confirmed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  if(!(db.query('PRAGMA table_info(login_requests)').all() as {name:string}[]).some(c=>c.name==='device_peer'))db.exec('ALTER TABLE login_requests ADD COLUMN device_peer TEXT');
  if(!(db.query('PRAGMA table_info(login_requests)').all() as {name:string}[]).some(c=>c.name==='language'))db.exec("ALTER TABLE login_requests ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
  const identify=accounts(db),news=newsletter(db);
  const devices=config.devices?deviceRegistry(db,origin,config.devices):undefined;
  const headers = {'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY'};
  const json = (status: number, value: unknown) => Response.json(value,{status,headers});
  const page = (title: string, content: string, script = '', status = 200, language:LoginLanguage = 'en') => {
    const nonce = random();
    return new Response(`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Qoopia</title>
      ${brandHead}
      <body class="q-auth"><main>${brandLockup}<h1>${escape(title)}</h1>${content}</main>${script?`<script nonce="${nonce}">${script}</script>`:''}</html>`,{status,headers:{...headers,'content-type':'text/html; charset=utf-8',
        'content-security-policy':`default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`}});
  };
  // ponytail: one SQLite counter store; split only when one sign-in server is insufficient.
  const allowance = db.transaction((key: string, limit: number, windowMs: number) => {
    const bucket = hash(key+':'+Math.floor(Date.now()/windowMs));
    const row = db.query('SELECT count FROM login_limits WHERE key=?').get(bucket) as {count:number}|null;
    if (row && row.count >= limit) return false;
    db.query('INSERT INTO login_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(bucket,Date.now()+windowMs);
    return true;
  });
  const providerJson = async (url: string, init: RequestInit) => {
    const response = await request(url,{...init,signal:AbortSignal.timeout(15_000),redirect:'error'});
    if (!response.ok) throw new Error('Sign-in provider is temporarily unavailable');
    return await response.json() as Record<string,unknown>;
  };
  async function sendConfirmation(flow: Flow, identity: LoginIdentity) {
    if (!allowance('email:'+identity.email,3,3_600_000) || !allowance('sending',80,86_400_000)) throw new Error('Too many sign-in emails. Please try again later');
    const token = random();
    db.query('UPDATE login_requests SET email=?,google_sub=?,mail_token=?,state=NULL,pkce=NULL WHERE id=?').run(identity.email,identity.googleSub??null,hash(token),flow.id);
    const link = origin+'/confirm?lang='+loginLanguage(flow.language)+'#'+token;
    const mailStarted=performance.now();
    try{await providerJson('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+config.resendKey,'content-type':'application/json','idempotency-key':'qoopia-login-'+flow.id},body:JSON.stringify({
      from:config.from,to:[identity.email],...confirmationMail(link,loginLanguage(flow.language)),
      attachments:[{filename:'qoopia.png',content_id:'qoopia-brand',content:readFileSync(assetPath('src/public/brand/email-lockup.png')).toString('base64')}]
    })});record({kind:'mail_accepted',language:loginLanguage(flow.language),method:identity.googleSub?'google':'email',duration_ms:Math.min(300000,Math.round(performance.now()-mailStarted))});}
    catch(error){record({kind:'mail_failed',language:loginLanguage(flow.language),outcome:'error'});throw error;}
  }
  const handler=async (req: Request, clientIp: string): Promise<Response> => {
    const url = new URL(req.url), now = Date.now();
    // HTTPS terminates at Cloudflare; the service itself listens on loopback only.
    if ((req.headers.get('host')??url.host) !== new URL(origin).host) return json(403,{error:'Host refused'});
    db.query('DELETE FROM login_requests WHERE expires<=?').run(now);
    db.query('DELETE FROM login_limits WHERE expires<=?').run(now);
    if (!allowance('requests:'+clientIp,300,60_000)) return json(429,{error:'Please try again shortly'});
    try {
      if(url.pathname==='/analytics/events'){
        if(!config.browserWrite)return new Response(null,{status:503});
        if(!allowance('analytics-global',100_000,86_400_000)||!allowance('analytics:'+clientIp,60,60_000))return new Response(null,{status:429});
        return browserEvent(req,config.browserWrite);
      }
      if(url.pathname==='/devices'){
        // Host was checked above. Restore the configured public origin after
        // loopback HTTP termination; signed RPCs still bind the HTTPS audience.
        // Never derive it from client-supplied forwarding headers.
        return devices?await devices.handler(new Request(origin+url.pathname+url.search,req)):json(503,{code:'DEVICE_SERVICE_UNAVAILABLE'});
      }
      if(req.method==='GET'||req.method==='HEAD'){const asset=brandAsset(url.pathname);if(asset)return new Response(req.method==='HEAD'?null:new Uint8Array(asset.body),{headers:{...headers,'content-type':asset.type,'cache-control':'no-cache'}});}
      if (req.method === 'GET' && url.pathname === '/health') return json(200,{ready:Boolean(config.resendKey&&config.googleClientId&&config.googleClientSecret)});
      if (req.method === 'GET' && url.pathname === '/') return new Response(null,{status:302,headers:{...headers,location:'/profile'+url.search}});
      if(url.pathname==='/news/unsubscribe')return unsubscribePage(req,news,page);
      if(url.pathname==='/owner'||url.pathname.startsWith('/owner/')||url.pathname==='/profile'||url.pathname.startsWith('/profile/'))return profile.handler(req,clientIp);
      if (req.method === 'GET' && url.pathname === '/privacy') return page('Sign-in & bridge privacy','<p>Qoopia uses your email address and, when you choose Google, your Google account identifier to confirm sign-in. It does not request access to your inbox, files, contacts, or calendar.</p><p>Pending sign-in requests are removed after ten minutes. Temporary abuse-prevention counters expire within one day. Resend delivers confirmation emails; Google handles Google account selection. Those providers process information under their own policies.</p><p>Your notes, tasks, conversations, and model credentials remain in your Qoopia installation. Signing in does not upload or synchronise that workspace.</p><h2>Service statistics</h2><p>Qoopia keeps aggregate operational counts and timestamped sign-in events (step, language, success or error, and duration) in a separate analytics store. Analytics events do not include email addresses, passwords, tokens, confirmation links or memory content. Website analytics is optional, uses no persistent visitor identifier, and respects the choice in website privacy settings.</p><h2>Website profile</h2><p>After you confirm your email, your profile stores your account identity and an optional dashboard address you choose to save. Profile sessions last seven days; pending website sign-ins expire after ten minutes. You can remove the saved address or sign out in your profile. A saved address is a navigation shortcut, not permission to access a workspace. Your notes and model credentials remain in your installation.</p><h2>Optional Qoopia news</h2><p>News, release announcements and guides are sent only if you opt in. The checkbox is off by default. You can change your choice in your profile or unsubscribe using the link in any newsletter, without signing in. Sign-in messages are separate and continue when you unsubscribe from news.</p><p>The private account store records your subscription email, language, choice, time, source and consent-text version. It also records new account creation dates and successful sign-in times and counts. Historical registration dates are not reconstructed. Only the designated service owner can view account-level records. Consent history is kept while needed to honour your choice and demonstrate consent; deletion requests can be directed to the sender contact in our messages. News delivery records contain the campaign, outcome and provider message identifier; no email-open tracking is added.</p><h2>Optional external connections</h2><p>When you enable external access, this service links your confirmed account to independent installation identifiers, workspace identifiers, device public keys, labels and routing addresses. It stores provisioning and revocation state, and hashes of short-lived enrollment grants. Revoked device identifiers remain as tombstones so a revoked key cannot silently regain access. It does not receive your memory database or private device keys.</p><p>Cloudflare Tunnel carries authorized MCP requests and results. Cloudflare terminates HTTPS and can process transit content, IP addresses, timing and traffic volume. This path is not end-to-end encrypted. The local installation enforces each client permission; the account service does not execute memory tools. Disabling external access stops the connection without deleting local memory.</p><h2>Optional bridges</h2><p>When you create or join a bridge, the Qoopia pilot relay stores the group name, display names, installation public keys, membership decisions and invitation hashes. These are independent of your sign-in email. Membership records remain while the group exists and are removed within thirty days after its creator closes it. Expired invitation records are removed after one additional day.</p><p>Catalogues and selected files are signed by their sender and encrypted for their intended recipient. The relay has no private decryption keys. It temporarily buffers encrypted packets in memory for up to two minutes; the sender retains its own delivery queue. The relay observes network addresses, participant routing, timing and traffic volume. Membership freshness and delivery availability rely on the relay. Leaving or removal ends new access but cannot erase copies already received.</p><p>The pilot uses existing Qoopia hosting, with limits of 32 installations per bridge, 100 published entries per catalogue and 1 MiB per material. No payment is requested by this flow. Local memory remains available when the relay is offline.</p>');
      if (req.method === 'GET' && url.pathname === '/confirm') {
        const language=loginLanguage(url.searchParams.get('lang')),view=confirmationView(language);
        return page(view.title,view.content,view.script,200,language);
      }
      if (req.method === 'GET' && url.pathname === '/google') {
        const id = url.searchParams.get('request')??'';
        const flow = db.query('SELECT * FROM login_requests WHERE id=? AND email IS NULL').get(id) as Flow|null;
        if (!flow || !config.googleClientId || !config.googleClientSecret) return page('Start again','<p>Return to Qoopia and start a new sign-in.</p>','',400);
        const state=random(),pkce=random();
        db.query('UPDATE login_requests SET state=?,pkce=? WHERE id=?').run(hash(state),pkce,id);
        const google=new URL('https://accounts.google.com/o/oauth2/v2/auth');
        google.search=new URLSearchParams({client_id:config.googleClientId,redirect_uri:origin+'/google/callback',response_type:'code',scope:'openid email',prompt:'select_account',state,code_challenge:createHash('sha256').update(pkce).digest('base64url'),code_challenge_method:'S256'}).toString();
        return new Response(null,{status:302,headers:{...headers,location:google.href,'set-cookie':`__Host-qoopia_google_${id}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`}});
      }
      if (req.method === 'GET' && url.pathname === '/google/callback') {
        const state=url.searchParams.get('state')??'',code=url.searchParams.get('code')??'';
        if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length>2048) return page('Sign-in cancelled','<p>Return to Qoopia to try again.</p>','',400);
        const flow=db.query('SELECT * FROM login_requests WHERE state=?').get(hash(state)) as Flow|null;
        if (!flow || !req.headers.get('cookie')?.split(';').some(v=>v.trim()===`__Host-qoopia_google_${flow.id}=${state}`)) return json(403,{error:'Sign-in state expired or invalid'});
        db.query('UPDATE login_requests SET state=NULL,pkce=NULL WHERE id=?').run(flow.id);
        // Google OIDC userinfo is fetched directly over TLS using this PKCE-bound code's access token.
        const token=await providerJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.googleClientId,client_secret:config.googleClientSecret,code,code_verifier:flow.pkce!,grant_type:'authorization_code',redirect_uri:origin+'/google/callback'})});
        if (typeof token.access_token!=='string') throw new Error('Google did not confirm this sign-in');
        const user=await providerJson('https://openidconnect.googleapis.com/v1/userinfo',{headers:{authorization:'Bearer '+token.access_token}});
        if (user.email_verified!==true || typeof user.sub!=='string' || !user.sub || user.sub.length>255) throw new Error('Google did not confirm this email address');
        await sendConfirmation(flow,{email:loginEmail(user.email),googleSub:user.sub});
        const ru=flow.language==='ru';
        const response=page(ru?'Проверьте почту':'Check your email',`<p>${ru?'Ссылка для подтверждения отправлена на':'A confirmation link was sent to'} ${escape(loginEmail(user.email))}. ${ru?'Подтвердите вход и вернитесь на страницу Qoopia, где начали вход.':'Confirm it, then return to the Qoopia page where you started.'}</p>`,'',200,loginLanguage(flow.language));
        response.headers.set('set-cookie',`__Host-qoopia_google_${flow.id}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
        return response;
      }
      if (req.method !== 'POST') return json(404,{error:'Not found'});
      if (req.headers.get('origin') && req.headers.get('origin')!==origin) return json(403,{error:'Origin refused'});
      if (req.headers.get('content-type')?.split(';')[0]!=='application/json') return json(400,{error:'JSON required'});
      const text=await req.text();if(text.length>2048)return json(413,{error:'Request too large'});
      const body=JSON.parse(text);
      if (!body || typeof body!=='object' || Array.isArray(body)) return json(400,{error:'Invalid request'});
      if (url.pathname === '/requests') {
        if (!['email','google'].includes(body.method) || !/^[a-f0-9]{64}$/.test(body.challenge)) return json(400,{error:'Invalid sign-in request'});
        if(body.device_peer!==undefined&&(!devices||typeof body.device_peer!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.device_peer)))return json(400,{error:'Device registration is unavailable'});
        if (!allowance('start:'+clientIp,20,3_600_000)) return json(429,{error:'Too many sign-in attempts. Please try again later'});
        const email=body.method==='email'?loginEmail(body.email):undefined,id=random(),language=loginLanguage(body.language);
        db.query('INSERT INTO login_requests(id,challenge,expires,device_peer,language) VALUES (?,?,?,?,?)').run(id,body.challenge,now+lifetime,body.device_peer??null,language);
        record({kind:'auth_request',method:body.method,language});
        try {
          if(email)await sendConfirmation({id,language} as Flow,{email});
        }catch(error){db.query('DELETE FROM login_requests WHERE id=?').run(id);throw error;}
        return json(201,{id,expires_in:600,...(email?{email}:{google_url:origin+'/google?request='+id})});
      }
      if (url.pathname === '/confirm') {
        if (req.headers.get('origin')!==origin || typeof body.token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) return json(400,{error:'Invalid confirmation link'});
        const result=db.query('UPDATE login_requests SET confirmed=1,mail_token=NULL WHERE mail_token=? AND confirmed=0 AND expires>?').run(hash(body.token),now);
        if(result.changes)record({kind:'email_confirmed',outcome:'ok'});
        return result.changes?json(200,{ok:true}):json(400,{error:'This link expired or was already used. Request a new sign-in from Qoopia.'});
      }
      if (url.pathname === '/redeem') {
        if(typeof body.id!=='string'||typeof body.verifier!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.verifier)) return json(400,{error:'Invalid sign-in request'});
        const flow=db.query('SELECT * FROM login_requests WHERE id=? AND challenge=?').get(body.id,hash(body.verifier)) as Flow|null;
        if(!flow)return json(410,{error:'Sign-in expired. Please start again'});
        if(!flow.confirmed)return json(202,{pending:true});
        // Grant issuance and proof consumption share a transaction: a replay cannot obtain a second account grant.
        return db.transaction(()=>{
          if(!db.query('DELETE FROM login_requests WHERE id=? AND confirmed=1').run(flow.id).changes)return json(410,{error:'Sign-in expired. Please start again'});
          record({kind:'login_redeemed',method:flow.google_sub?'google':'email',language:loginLanguage(flow.language),outcome:'ok'});
          const identity={email:flow.email!,...(flow.google_sub?{googleSub:flow.google_sub}:{})};
          const accountId=identify(identity);
          db.query('UPDATE account_activity SET last_login_at=?,login_count=login_count+1 WHERE account_id=?').run(now,accountId);
          return json(200,{...identity,...(flow.device_peer&&devices?{device_grant:devices.issueGrant(identity,flow.device_peer)}:{})});
        })();
      }
      return json(404,{error:'Not found'});
    }catch(error){return json(400,{error:error instanceof SyntaxError?'Invalid request':error instanceof Error?error.message:'Sign-in failed'});}
  };
  const profile=profilePortal(db,origin,page,(route,body,ip)=>handler(new Request(origin+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),ip),record,config.owner);
  const observedHandler=async(req:Request,ip:string)=>{
    const start=performance.now(),response=await handler(req,ip),path=new URL(req.url).pathname;
    const routes:Record<string,'profile'|'confirm'|'google'|'requests'|'redeem'|'devices'>={'/profile':'profile','/profile/start':'profile','/profile/logout':'profile','/profile/dashboard':'profile','/confirm':'confirm','/google':'google','/google/callback':'google','/requests':'requests','/redeem':'redeem','/devices':'devices'};
    if(routes[path])record({kind:'auth_http',page:routes[path],outcome:response.status>=500?'error':response.status>=400?'rejected':response.status===202?'pending':'ok',duration_ms:Math.min(300000,Math.round(performance.now()-start))});
    return response;
  };
  return Object.assign(observedHandler,{maintenance:async()=>{profile.cleanup();devices?.cleanup();await devices?.reconcileRevocations();}});
}

if (import.meta.main) {
  process.umask(0o077);
  const config:Config={origin:process.env.QOOPIA_LOGIN_ORIGIN??'https://auth.qoopia.ai',resendKey:process.env.RESEND_API_KEY??'',from:process.env.QOOPIA_LOGIN_FROM??'Qoopia <login@mail.qoopia.ai>',googleClientId:process.env.GOOGLE_CLIENT_ID??'',googleClientSecret:process.env.GOOGLE_CLIENT_SECRET??''};
  config.owner={accountId:process.env.QOOPIA_OWNER_ACCOUNT_ID,analyticsFile:process.env.QOOPIA_OWNER_ANALYTICS_FILE,releaseTag:process.env.QOOPIA_PUBLIC_RELEASE_TAG,postalAddress:process.env.QOOPIA_NEWS_POSTAL_ADDRESS};
  if(process.env.QOOPIA_CF_TOKEN_FILE){
    const fd=openSync(process.env.QOOPIA_CF_TOKEN_FILE,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.mode&0o077||stat.size>8192)throw new Error('Use a private operator token file');
      config.devices={domain:process.env.QOOPIA_CONNECTION_DOMAIN??'qoopia.ai',provider:cloudflareTunnels({account:process.env.QOOPIA_CF_ACCOUNT??'',zone:process.env.QOOPIA_CF_ZONE??'',token:readFileSync(fd,'utf8').trim()})};
    }finally{closeSync(fd);}
  }
  if(!config.resendKey||!config.googleClientId||!config.googleClientSecret)throw new Error('Configure the email and Google providers before starting the sign-in service');
  const db=new Database(process.env.QOOPIA_LOGIN_DB??'login.sqlite',{create:true});db.exec('PRAGMA journal_mode=WAL');
  let analytics:ReturnType<typeof persistentAnalytics>;
  try{analytics=persistentAnalytics(process.env.QOOPIA_ANALYTICS_DB);}catch{console.error('Analytics store unavailable; sign-in remains available');}
  if(analytics){config.recordEvent=analytics.record;config.browserWrite=raw=>analytics!.store.write(raw,'browser');}
  const handler=loginBroker(db,config);
  const relay=bridgeRelay(db,new URL(config.origin).origin+'/bridge');
  setInterval(()=>{
    db.query('DELETE FROM login_requests WHERE expires<=?').run(Date.now());
    db.query('DELETE FROM login_limits WHERE expires<=?').run(Date.now());
    relay.cleanup();
    void handler.maintenance();
  },30_000).unref();
  Bun.serve({hostname:'127.0.0.1',port:Number(process.env.QOOPIA_LOGIN_PORT??3740),maxRequestBodySize:MAX_RPC,
    fetch:req=>(new URL(req.url).pathname.startsWith('/bridge/')?relay:handler)(req,req.headers.get('cf-connecting-ip')??'local')});
  console.log('Qoopia sign-in service ready');
}
