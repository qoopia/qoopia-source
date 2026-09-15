import {randomBytes,createHash} from 'node:crypto';
import type {Database} from 'bun:sqlite';
import {LOGIN_ORIGIN,ownerIdentity} from './local.ts';
import {brandHead,brandLockup} from '../brand.ts';
import {loginEmail} from './broker.ts';
import {localOwner} from '../delivery/owner-onboarding.ts';
import {connectionOrigin,publicConnection,resourceConnection} from '../services/connection-identity.ts';
import {getConsentTicket,consentTicketStatus,getClient,approveConsentTicket,denyConsentTicket} from '../auth/oauth.ts';

export const CONSENT_COOKIE_PREFIX='__Secure-qoopia_consent_';
const loginCookie=CONSENT_COOKIE_PREFIX+'login';
const random=()=>randomBytes(32).toString('base64url');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Flow={ticket:string;nonce:string;expires:number;owner:string;version:number;verified:boolean;busy:boolean;
  binding?:string;login?:{id:string;verifier:string;method:'email'|'google'};language:'en'|'ru'};
class ConsentError extends Error {constructor(readonly code:string,readonly status=400){super(code);}}

/** A separate, browser-bound consent session can authorize only one prepared client agent. */
export function remoteConnectionConsent(root:string,database:Database,request:typeof fetch=fetch,loginOrigin=LOGIN_ORIGIN) {
  const flows=new Map<string,Flow>();
  const proofs=new Map<string,{owner:string;version:number;binding:string;expires:number}>();
  const post=async(route:string,body:unknown)=>{
    const response=await request(loginOrigin+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
      redirect:'error',signal:AbortSignal.timeout(20_000)});
    const text=await response.text();if(text.length>4096)throw new ConsentError('SIGN_IN_UNAVAILABLE',503);
    const data=JSON.parse(text) as Record<string,unknown>;
    if(!response.ok)throw new ConsentError(response.status===410?'SIGN_IN_EXPIRED':'SIGN_IN_UNAVAILABLE',response.status===410?410:503);
    return data;
  };
  return async(req:Request):Promise<Response>=>{
    const url=new URL(req.url),route=url.pathname;
    let form=new URLSearchParams(),ticketId=url.searchParams.get('ticket')??'',flow:Flow|undefined,issuedProof:string|undefined;
    const t=(en:string,ru:string)=>flow?.language==='ru'?ru:en;
    // no-referrer makes native form POSTs send Origin: null. Preserve the exact
    // same-origin check without sending consent URLs to external destinations.
    const headers={'cache-control':'no-store','referrer-policy':'same-origin','x-content-type-options':'nosniff','x-frame-options':'DENY',
      'content-security-policy':"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
    const page=(body:string,status=200)=>new Response(`<!doctype html><html lang="${flow?.language??'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qoopia — ${t('Connection access','Доступ к памяти')}</title>${brandHead}<body class="q-auth"><main class="q-consent">${brandLockup}<nav class="languages" aria-label="Language"><a lang="en" href="/oauth/consent?ticket=${escape(ticketId)}&lang=en">EN</a> / <a lang="ru" href="/oauth/consent?ticket=${escape(ticketId)}&lang=ru">RU</a></nav>${body}</main></html>`,{status,headers:{...headers,'content-type':'text/html; charset=utf-8'}});
    const action=(name:string,label:string,extra='',quiet=false)=>`<form method="post" action="/oauth/consent/${name}"${quiet?' class="quiet"':''}><input type="hidden" name="ticket" value="${escape(ticketId)}"><input type="hidden" name="nonce" value="${flow!.nonce}">${extra}<button type="submit">${label}</button></form>`;
    try{
      for(const [key,value] of flows)if(value.expires<=Date.now())flows.delete(key);
      for(const [key,value] of proofs)if(value.expires<=Date.now())proofs.delete(key);
      if(req.method==='POST'){
        if(req.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')throw new ConsentError('FORM_REQUIRED');
        const body=await req.text();if(body.length>2048)throw new ConsentError('REQUEST_TOO_LARGE',413);
        form=new URLSearchParams(body);ticketId=form.get('ticket')??'';
        for(const key of ['ticket','nonce','method','email'])if(form.getAll(key).length>1)throw new ConsentError('INVALID_REQUEST');
      }else if(req.method!=='GET'||route!=='/oauth/consent')throw new ConsentError('NOT_FOUND',404);
      const ticket=getConsentTicket(ticketId);
      if(!ticket||consentTicketStatus(ticket)!=='ok'||ticket.approved_by_agent_id)throw new ConsentError('CONSENT_EXPIRED',410);
      const id=ticket.resource?resourceConnection(ticket.resource):undefined;
      if(!id)throw new ConsentError('SCOPED_CONNECTION_REQUIRED',403);
      const connection=publicConnection(id),origin=connectionOrigin(id),client=getClient(ticket.client_id);
      if(!origin.startsWith('https://')||client?.agent_id!==connection.agent_id||client.workspace_id!==connection.workspace_id||ticket.workspace_id!==connection.workspace_id)
        throw new ConsentError('CONNECTION_UNAVAILABLE',403);
      const callback=new URL(ticket.redirect_uri);
      if(!client.redirect_uris.includes(ticket.redirect_uri)||!['http:','https:'].includes(callback.protocol))
        throw new ConsentError('CONNECTION_UNAVAILABLE',403);
      // Browsers apply form-action to the final OAuth redirect as well. Allow
      // only this ticket's registered client origin, never arbitrary sites.
      headers['content-security-policy']=headers['content-security-policy'].replace("form-action 'self';",`form-action 'self' ${callback.origin};`);
      const binding=ownerIdentity(root),owner=binding?localOwner(database,binding.ownerId):null;
      if(!binding||owner?.agent_id!==connection.owner_id||owner.workspace_id!==connection.workspace_id)
        throw new ConsentError('OWNER_SETUP_REQUIRED',403);
      const cookieName=CONSENT_COOKIE_PREFIX+hash(ticketId).slice(0,16);
      const cookies=(req.headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));
      if(cookies.length>1)throw new ConsentError('INVALID_SESSION',403);
      let token=cookies[0]?.slice(cookieName.length+1)??'';
      flow=flows.get(hash(token));
      let newCookie=false;
      if(req.method==='GET'){
        if(!flow){
          if(flows.size>=100||[...flows.values()].filter(f=>f.ticket===ticketId).length>=5)throw new ConsentError('TOO_MANY_ATTEMPTS',429);
          token=random();flow={ticket:ticketId,nonce:random(),expires:Math.min(Date.parse(ticket.expires_at),Date.now()+600_000),
            owner:owner.agent_id,version:owner.session_version!,verified:false,busy:false,language:url.searchParams.get('lang')==='ru'?'ru':'en'};
          const identityCookies=(req.headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(loginCookie+'='));
          const proof=identityCookies.length===1?proofs.get(hash(identityCookies[0]!.slice(loginCookie.length+1))):undefined;
          if(proof?.owner===owner.agent_id&&proof.version===owner.session_version&&proof.binding===hash(JSON.stringify(binding))){
            flow.verified=true;flow.binding=proof.binding;flow.expires=Math.min(flow.expires,proof.expires);
          }
          flows.set(hash(token),flow);newCookie=true;
        }
        if(['en','ru'].includes(url.searchParams.get('lang')??''))flow.language=url.searchParams.get('lang') as 'en'|'ru';
      }
      if(!flow||flow.ticket!==ticketId||flow.owner!==owner.agent_id||flow.version!==owner.session_version)
        throw new ConsentError('SIGN_IN_EXPIRED',403);
      if(flow.verified&&flow.binding!==hash(JSON.stringify(binding))){flows.delete(hash(token));throw new ConsentError('SIGN_IN_EXPIRED',403);}
      if(req.method==='POST'){
        if(req.headers.get('origin')!==origin||form.get('nonce')!==flow.nonce)throw new ConsentError('ORIGIN_OR_SESSION_REFUSED',403);
        if(flow.busy)throw new ConsentError('ACTION_IN_PROGRESS',409);
        flow.nonce=random();flow.busy=true;
        try{
          if(route==='/oauth/consent/start'){
            if(flow.verified)throw new ConsentError('ALREADY_SIGNED_IN',409);
            const method=form.get('method');if(method!=='email'&&method!=='google')throw new ConsentError('INVALID_REQUEST');
            const verifier=random(),data=await post('/requests',{method,language:flow.language,...(method==='email'?{email:loginEmail(form.get('email'))}:{}),challenge:hash(verifier)});
            if(typeof data.id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.id))throw new ConsentError('SIGN_IN_UNAVAILABLE',503);
            flow.login={id:data.id,verifier,method};
          }else if(route==='/oauth/consent/check'){
            if(!flow.login)throw new ConsentError('SIGN_IN_REQUIRED',403);
            const data=await post('/redeem',{id:flow.login.id,verifier:flow.login.verifier});
            if(data.pending!==true){
              delete flow.login;
              if(data.email!==binding.email&&(!binding.googleSub||data.googleSub!==binding.googleSub))throw new ConsentError('WRONG_ACCOUNT',403);
              flow.verified=true;flow.binding=hash(JSON.stringify(binding));
              // Reuse only the short-lived identity proof. Every new client still requires its own explicit consent.
              if(proofs.size>=100)proofs.delete(proofs.keys().next().value!);
              issuedProof=random();proofs.set(hash(issuedProof),{owner:owner.agent_id,version:flow.version,binding:flow.binding,expires:Date.now()+600_000});
            }
          }else if(route==='/oauth/consent/approve'){
            if(!flow.verified)throw new ConsentError('SIGN_IN_REQUIRED',403);
            // Re-check active human authority and exact client binding after the human confirmation.
            const current=localOwner(database,owner.agent_id),active=publicConnection(id);
            if(current.session_version!==flow.version||current.workspace_id!==active.workspace_id||active.agent_id!==client.agent_id||active.owner_id!==current.agent_id)
              throw new ConsentError('AUTHORITY_CHANGED',403);
            if(!approveConsentTicket(ticket.id,active.agent_id))throw new ConsentError('CONSENT_EXPIRED',410);
            flows.delete(hash(token));
            return new Response(null,{status:303,headers:{...headers,location:origin+'/oauth/authorize/finalize?'+new URLSearchParams({ticket:ticket.id})}});
          }else if(route==='/oauth/consent/deny'){
            if(!denyConsentTicket(ticket.id))throw new ConsentError('CONSENT_EXPIRED',410);
            flows.delete(hash(token));const target=new URL(ticket.redirect_uri);target.searchParams.set('error','access_denied');
            target.searchParams.set('iss',origin+'/oauth/c/'+id);
            if(ticket.state)target.searchParams.set('state',ticket.state);
            return new Response(null,{status:303,headers:{...headers,location:target.href}});
          }else throw new ConsentError('NOT_FOUND',404);
        }finally{flow.busy=false;}
      }
      let content=`<h1>${t('Connect your memory','Подключение памяти')}</h1>`;
      if(flow.verified){
        const space=database.query('SELECT name FROM workspaces WHERE id=?').get(connection.workspace_id) as {name:string};
        content+=`<p>${t('Review this client’s access before continuing.','Проверьте права клиента перед продолжением.')}</p><dl><dt>${t('Workspace','Пространство')}</dt><dd>${escape(space.name)}</dd><dt>${t('Client','Клиент')}</dt><dd>${escape(client.name)}</dd><dt>${t('Permissions','Права')}</dt><dd>${ticket.scope.split(' ').includes('mcp:write')?t('Read and write memory','Чтение и запись памяти'):t('Read memory only','Только чтение памяти')}</dd></dl><p>${t('Your memory stays on the selected installation. Authorized results pass through Cloudflare to this client. This does not connect a background model or capture your entire chat.','Память остаётся на выбранной установке. Разрешённые результаты проходят через Cloudflare к этому клиенту. Это не подключает фоновую модель и не сохраняет всю переписку.')}</p>`;
        content+=action('approve',t('Allow this client','Разрешить этому клиенту'));
      }else if(flow.login){
        content+=`<p>${t('Finish account confirmation, then return here.','Завершите подтверждение аккаунта и вернитесь сюда.')}</p>`;
        if(flow.login.method==='google')content+=`<p><a target="_blank" rel="noopener noreferrer" href="${loginOrigin}/google?request=${flow.login.id}">${t('Continue with Google','Продолжить через Google')} ↗</a></p>`;
        else content+=`<p>${t('Open the link in your email to confirm.','Для подтверждения откройте ссылку из письма.')}</p>`;
        content+=action('check',t('I confirmed — continue','Я подтвердил — продолжить'));
      }else{
        content+=`<p>${t('Sign in to the Qoopia account linked to this installation. You will review the permissions next.','Войдите в аккаунт Qoopia, связанный с этой установкой. Затем вы сможете проверить права клиента.')}</p>`;
        content+=action('start',t('Confirm by email','Подтвердить по почте'),`<input type="hidden" name="method" value="email"><label>${t('Email','Почта')}<input type="email" name="email" spellcheck="false" required autocomplete="email" maxlength="254"></label>`);
        content+=action('start',t('Continue with Google','Продолжить через Google'),'<input type="hidden" name="method" value="google">',true);
      }
      content+=action('deny',t('Cancel connection','Отменить подключение'),'',true);
      const response=page(content);
      if(newCookie)response.headers.set('set-cookie',`${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/oauth/consent; Max-Age=600`);
      if(issuedProof)response.headers.append('set-cookie',`${loginCookie}=${issuedProof}; HttpOnly; Secure; SameSite=Lax; Path=/oauth/consent; Max-Age=600`);
      return response;
    }catch(error){
      const code=error instanceof ConsentError?error.code:'SIGN_IN_UNAVAILABLE',status=error instanceof ConsentError?error.status:503;
      const message=code==='WRONG_ACCOUNT'?t('Use the account linked to this installation.','Используйте аккаунт, связанный с этой установкой.'):
        code==='CONSENT_EXPIRED'?t('This request expired or is already complete. Return to the client and start again.','Запрос истёк или уже завершён. Вернитесь в клиент и начните снова.'):
        t('The connection could not continue. Reopen this consent page, or resume setup in Qoopia.','Не удалось продолжить подключение. Откройте страницу согласия заново или продолжите настройку в Qoopia.');
      return page(`<h1>${t('Connection needs attention','Требуется ваше действие')}</h1><p>${message}</p><small>${code}</small>`,status);
    }
  };
}
