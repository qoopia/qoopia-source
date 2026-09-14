import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {assetPath} from '../utils/assets.ts';
import {newsletter,newsMessage} from './newsletter.ts';
import type {LoginLanguage} from './messages.ts';

type Campaign={id:string;subject:string;body:string;language:LoginLanguage;created_at:number};
export function prepareNews(db:Database,subject:string,body:string,language:LoginLanguage){
 newsletter(db);
 if(!subject.trim()||subject.length>160||Array.from(subject).some(c=>c.charCodeAt(0)<32)||!body.trim()||body.length>30000||!['en','ru'].includes(language))throw new Error('INVALID_CAMPAIGN');
 const id=randomUUID();db.query('INSERT INTO news_campaigns VALUES (?,?,?,?,?)').run(id,subject.trim(),body.trim(),language,Date.now());return id;
}
export function previewNews(db:Database,id:string){
 const store=newsletter(db),campaign=db.query('SELECT * FROM news_campaigns WHERE id=?').get(id) as Campaign|null;
 if(!campaign)throw new Error('CAMPAIGN_NOT_FOUND');
 return {campaign,eligible:store.eligible(campaign.language).length,attempted:(db.query('SELECT count(*) n FROM news_deliveries WHERE campaign_id=?').get(id) as {n:number}).n};
}
/** An explicit operator call only. Never retried automatically after an uncertain send. */
export async function sendNews(db:Database,id:string,config:{origin:string;from:string;postalAddress:string;resendKey:string},request:typeof fetch=fetch){
 if(!config.postalAddress.trim()||config.postalAddress.length>1000||!config.from||!config.resendKey||new URL(config.origin).protocol!=='https:')throw new Error('SENDER_DETAILS_REQUIRED');
 const store=newsletter(db),{campaign}=previewNews(db,id);
 const result={accepted:0,failed:0,uncertain:0,skipped:0,limited:false};
 // Reserve capacity for sign-in emails; no plan upgrades or unattended bulk runs.
 const dayStart=Date.now()-Date.now()%86400000;
 let remaining=Math.max(0,20-(db.query("SELECT count(*) n FROM news_deliveries WHERE at>=? AND status<>'skipped'").get(dayStart) as {n:number}).n);
 const attachment={filename:'qoopia.png',content_id:'qoopia-brand',content:readFileSync(assetPath('src/public/brand/email-lockup.png')).toString('base64')};
 for(const recipient of store.eligible(campaign.language)){
  if(!remaining){result.limited=true;break;}
  const claim=db.transaction(()=>{
   if(db.query('SELECT 1 FROM news_deliveries WHERE campaign_id=? AND account_id=?').get(id,recipient.account_id))return false;
   const current=store.preference(recipient.account_id);
   const email=(db.query('SELECT email FROM connection_accounts WHERE id=?').get(recipient.account_id) as {email:string}|null)?.email;
   if(!current?.subscribed||current.revision!==recipient.revision||email!==recipient.email){result.skipped++;return false;}
   const daily=(db.query("SELECT count(*) n FROM news_deliveries WHERE at>=? AND status<>'skipped'").get(dayStart) as {n:number}).n;
   if(daily>=20){result.limited=true;return false;}
   db.query("INSERT INTO news_deliveries VALUES (?,?,'sending',?,NULL)").run(id,recipient.account_id,Date.now());return true;
  })();
  if(!claim)continue;
  remaining--;
  const unsubscribe=new URL('/news/unsubscribe',config.origin);unsubscribe.searchParams.set('token',store.token(recipient));unsubscribe.searchParams.set('lang',recipient.language);
  let status:'accepted'|'failed'|'uncertain'='uncertain',providerId:string|null=null;
  try{
   const response=await request('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+config.resendKey,'content-type':'application/json','idempotency-key':'qoopia-news-'+id+'-'+recipient.account_id},body:JSON.stringify({from:config.from,to:[recipient.email],...newsMessage(campaign,unsubscribe.href,config.postalAddress),attachments:[attachment]})});
   if(response.ok){const data=await response.json() as {id?:unknown};if(typeof data.id==='string'&&data.id.length<200){status='accepted';providerId=data.id;}}
   else if(response.status<500)status='failed';
  }catch{/* Do not retain provider errors, email addresses or URLs in command logs. */}
  db.query('UPDATE news_deliveries SET status=?,provider_id=? WHERE campaign_id=? AND account_id=?').run(status,providerId,id,recipient.account_id);
  result[status]++;
  if(status!=='accepted')break;
  await new Promise(resolve=>setTimeout(resolve,600));
 }
 return result;
}
