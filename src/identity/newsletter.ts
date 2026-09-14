import type {Database} from 'bun:sqlite';
import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {LoginLanguage} from './messages.ts';

export const NEWS_CONSENT_VERSION='2026-09-14-v1';
export const newsConsent={en:'Receive Qoopia news, new releases and useful guides by email. Unsubscribe at any time.',ru:'Получать по email новости Qoopia, новые релизы и полезные инструкции. Отписаться можно в любой момент.'};
export const escapeHtml=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export type NewsPreference={account_id:string;email:string;subscribed:number;language:LoginLanguage;revision:number;changed_at:number};

/** Private account metadata. No email addresses or link credentials enter analytics. */
export function newsletter(db:Database){
 db.exec(`CREATE TABLE IF NOT EXISTS news_preferences(account_id TEXT PRIMARY KEY,email TEXT NOT NULL,subscribed INTEGER NOT NULL CHECK(subscribed IN (0,1)),language TEXT NOT NULL,revision INTEGER NOT NULL,changed_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS news_consents(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,email TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL,source TEXT NOT NULL,language TEXT NOT NULL,text_version TEXT NOT NULL,text TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS news_consents_account ON news_consents(account_id,at);
 CREATE TABLE IF NOT EXISTS news_key(id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS news_campaigns(id TEXT PRIMARY KEY,subject TEXT NOT NULL,body TEXT NOT NULL,language TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS news_deliveries(campaign_id TEXT NOT NULL,account_id TEXT NOT NULL,status TEXT NOT NULL,at INTEGER NOT NULL,provider_id TEXT,PRIMARY KEY(campaign_id,account_id));`);
 db.query('INSERT OR IGNORE INTO news_key VALUES (1,?)').run(randomBytes(32).toString('hex'));
 const key=(db.query('SELECT secret FROM news_key WHERE id=1').get() as {secret:string}).secret;
 const preference=(id:string)=>db.query('SELECT * FROM news_preferences WHERE account_id=?').get(id) as NewsPreference|null;
 const change=db.transaction((account:{id:string;email:string},subscribed:boolean,language:LoginLanguage,source:'signup'|'profile'|'email')=>{
  const previous=preference(account.id);
  if(previous&&previous.subscribed===Number(subscribed)&&previous.email===account.email&&previous.language===language)return;
  const at=Date.now(),revision=(previous?.revision??0)+1;
  db.query('INSERT INTO news_preferences VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET email=excluded.email,subscribed=excluded.subscribed,language=excluded.language,revision=excluded.revision,changed_at=excluded.changed_at').run(account.id,account.email,Number(subscribed),language,revision,at);
  db.query('INSERT INTO news_consents VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(),account.id,account.email,subscribed?'subscribe':'unsubscribe',at,source,language,NEWS_CONSENT_VERSION,newsConsent[language]);
 });
 const sign=(value:string)=>createHmac('sha256',key).update(value).digest('base64url');
 const token=(p:NewsPreference)=>{const value=p.account_id+'.'+p.revision;return value+'.'+sign(value);};
 const resolve=(value:string)=>{
  if(value.length>160)return null;
  const match=/^([a-f0-9-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);if(!match)return null;
  if(!timingSafeEqual(Buffer.from(match[3]!),Buffer.from(sign(match[1]+'.'+match[2]))))return null;
  const p=preference(match[1]!);return p&&p.revision===Number(match[2])?p:null;
 };
 return {preference,change,token,resolve,unsubscribe:(value:string)=>{const p=resolve(value);if(p?.subscribed)change({id:p.account_id,email:p.email},false,p.language,'email');},
  eligible:(language:LoginLanguage)=>db.query('SELECT p.* FROM news_preferences p JOIN connection_accounts a ON a.id=p.account_id AND a.email=p.email WHERE p.subscribed=1 AND p.language=? ORDER BY p.account_id').all(language) as NewsPreference[]};
}

type Page=(title:string,content:string,script?:string,status?:number,language?:LoginLanguage)=>Response;
export async function unsubscribePage(req:Request,store:ReturnType<typeof newsletter>,page:Page){
 const url=new URL(req.url),token=url.searchParams.get('token')??'',p=store.resolve(token),ru=p?.language==='ru'||url.searchParams.get('lang')==='ru';
 const t=(en:string,ruText:string)=>ru?ruText:en;
 const title=t('Qoopia emails','Письма Qoopia');
 if(req.method==='POST'){
  if(req.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return new Response(null,{status:415});
  const body=await req.text();if(body.length>100)return new Response(null,{status:413});
  if(new URLSearchParams(body).get('List-Unsubscribe')!=='One-Click')return new Response(null,{status:400});
  if(!p)return page(title,`<p>${t('This link is no longer active. Check your current email preference in your profile.','Эта ссылка больше не активна. Проверьте текущую подписку в профиле.')}</p><a href="/profile">${t('Open profile','Открыть профиль')}</a>`,'',200,ru?'ru':'en');
  store.unsubscribe(token);
  return page(title,`<p>${t('You will no longer receive Qoopia news. Sign-in emails still work.','Новости Qoopia больше не будут приходить. Письма для входа продолжат работать.')}</p><a href="/profile">${t('Open profile','Открыть профиль')}</a>`,'',200,ru?'ru':'en');
 }
 if(req.method!=='GET')return new Response(null,{status:405});
 // Link scanners may GET this page. Only an explicit POST changes consent.
 const content=p?.subscribed?`<p>${t('Stop receiving news, releases and guides from Qoopia?','Отключить новости, релизы и инструкции Qoopia?')}</p><form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">${t('Unsubscribe','Отписаться')}</button></form>`:`<p>${t('This link is no longer active. You can check your email preferences in your profile.','Эта ссылка больше не активна. Проверить подписку можно в профиле.')}</p><a href="/profile">${t('Open profile','Открыть профиль')}</a>`;
 return page(title,content,'',200,ru?'ru':'en');
}

export function newsMessage(campaign:{subject:string;body:string;language:LoginLanguage},unsubscribe:string,postalAddress:string){
 const ru=campaign.language==='ru',footer=ru?'Вы подписались на новости Qoopia.':'You subscribed to Qoopia news.',label=ru?'Отписаться':'Unsubscribe';
 const e=escapeHtml;
 return {subject:campaign.subject,text:`${campaign.body}\n\n${footer}\n${label}: ${unsubscribe}\nQoopia · ${postalAddress}`,
  html:`<!doctype html><html lang="${campaign.language}"><body style="margin:0;background:#0B0A09;color:#FFFFFF"><table role="presentation" width="100%" bgcolor="#0B0A09"><tr><td style="padding:40px 24px"><div style="max-width:560px;margin:auto;font:17px/1.6 'IBM Plex Sans',Arial,sans-serif"><img src="cid:qoopia-brand" width="240" height="80" alt="Qoopia" style="max-width:100%;height:auto"><h1 style="font-size:32px;line-height:1.2">${e(campaign.subject)}</h1>${campaign.body.split(/\n\s*\n/).map(v=>`<p style="color:#FFFFFF;overflow-wrap:anywhere">${e(v).replace(/\n/g,'<br>')}</p>`).join('')}<hr style="border:0;border-top:1px solid #2A2724;margin:40px 0"><p style="color:#B7B1A6;font-size:14px">${footer}<br><a style="color:#FFFFFF" href="${e(unsubscribe)}">${label}</a><br>Qoopia · ${e(postalAddress)}</p></div></td></tr></table></body></html>`,
  headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}};
}
