import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {db} from '../db/connection.ts';
import {durableWrite,readJsonBytes,hash} from '../utils/fs.ts';
import {agentDirectory,agentOwner,agentSettings,myAgentAction,myAgentState,type AgentSettings} from './my-agent.ts';
import {QoopiaError} from '../utils/errors.ts';

type Pending={digest:string;expires:number;user?:{id:string;chat:string;name:string}};
const pending=new Map<string,Pending>(),polling=new Set<string>(),errors=new Map<string,string>();
const setupBusy=new Set<string>(),approvalNotices=new Map<string,Set<string>>();
let timer:ReturnType<typeof setInterval>|undefined;
const tokenFile=(owner:string)=>path.join(agentDirectory(owner),'telegram.json');
const token=(owner:string)=>(JSON.parse(readJsonBytes(tokenFile(owner)).toString()) as {token:string}).token;
/** Telegram errors can echo its URL (which contains a secret), so never propagate them. */
export async function telegramCall(secret:string,method:string,body:unknown):Promise<any> {
  try {
    const response=await fetch('https://api.telegram.org/bot'+secret+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000),redirect:'error'});
    const result=await response.json() as any;
    if(!response.ok||!result.ok)throw new Error('refused');return result.result;
  }catch{throw new QoopiaError('NOT_READY','Telegram did not accept the request. Check the token, network and other bot connections.');}
}
export function telegramState(owner:string){agentOwner(owner);const p=pending.get(owner);return {pending:p&&p.expires>Date.now()?{expires:p.expires,user:p.user??null}:null,error:errors.get(owner)??null,uncertain_deliveries:(db.query("SELECT COUNT(*) AS n FROM qoopia_agent_telegram_delivery d JOIN qoopia_agent_runs r ON r.id=d.run_id JOIN qoopia_agent_conversations c ON c.id=r.conversation_id WHERE c.owner_id=? AND d.state='uncertain'").get(owner) as {n:number}).n};}
const actionSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('telegram-connect'),token:z.string().trim().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/)}).strict(),
  z.object({action:z.literal('telegram-confirm'),userId:z.string(),chatId:z.string()}).strict(),
  z.object({action:z.literal('telegram-disconnect')}).strict(),
]);
export async function telegramAction(owner:string,raw:unknown) {
  const input=actionSchema.parse(raw),settings=agentSettings(owner);
  if(!settings?.enabled)throw new QoopiaError('NOT_READY','Set up My Qoopia agent first');
  if(setupBusy.has(owner))throw new QoopiaError('CONFLICT','A Telegram setup action is running');
  setupBusy.add(owner);
  try {
  if(input.action==='telegram-connect') {
    if(polling.has(owner)||settings.telegram_user_id)throw new QoopiaError('CONFLICT','Disconnect the current bot before changing it');
    const [bot,webhook]=await Promise.all([telegramCall(input.token,'getMe',{}),telegramCall(input.token,'getWebhookInfo',{})]);
    if(!bot.is_bot||!/^\w{5,32}$/.test(bot.username??''))throw new QoopiaError('INVALID_INPUT','Telegram bot has no valid username');
    if(webhook.url)throw new QoopiaError('CONFLICT','This bot has a webhook. Use a separate bot or disconnect its current application.');
    if(db.query('SELECT owner_id FROM qoopia_agent_settings WHERE telegram_username=? AND owner_id<>?').get(bot.username,owner))throw new QoopiaError('CONFLICT','This bot is already connected to another owner in this installation');
    durableWrite(tokenFile(owner),JSON.stringify({token:input.token}));
    const code=randomBytes(24).toString('base64url');pending.set(owner,{digest:hash(code),expires:Date.now()+600_000});
    db.query("UPDATE qoopia_agent_settings SET channel='telegram',telegram_username=?,telegram_offset=0,telegram_verified=0 WHERE owner_id=?").run(bot.username,owner);
    errors.delete(owner);startTelegramChannels();return {url:'https://t.me/'+bot.username+'?start='+code};
  }
  if(input.action==='telegram-confirm') {
    const p=pending.get(owner);
    if(!p||p.expires<Date.now()||!p.user||p.user.id!==input.userId||p.user.chat!==input.chatId)throw new QoopiaError('CONFLICT','Link expired or account changed. Connect again.');
    await telegramCall(token(owner),'sendMessage',{chat_id:input.chatId,text:'Qoopia подключена. Напишите вашему агенту. /new — новая задача, /stop — остановить. Подтверждения действий доступны в дашборде.\nQoopia is connected. Send your agent a message. /new starts a task; /stop stops it. Review approvals in your dashboard.'});
    db.query('UPDATE qoopia_agent_settings SET telegram_user_id=?,telegram_chat_id=? WHERE owner_id=?').run(input.userId,input.chatId,owner);pending.delete(owner);
    return {linked:true};
  }
  pending.delete(owner);errors.delete(owner);
  db.query("UPDATE qoopia_agent_settings SET channel='dashboard',telegram_username=NULL,telegram_user_id=NULL,telegram_chat_id=NULL,telegram_verified=0 WHERE owner_id=?").run(owner);
  // Stop polling before removing the secret; an in-flight poll rechecks binding before work.
  try{fs.unlinkSync(tokenFile(owner));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return {disconnected:true};
  }finally{setupBusy.delete(owner);}
}
export function isBoundTelegramMessage(settings:AgentSettings,message:any) {
  return message?.chat?.type==='private'&&String(message.from?.id)===settings.telegram_user_id&&String(message.chat?.id)===settings.telegram_chat_id&&!message.from?.is_bot;
}
export async function pollTelegramOwner(owner:string) {
  if(polling.has(owner))return;polling.add(owner);
  try {
    let settings=agentSettings(owner);if(!settings?.enabled||!settings.telegram_username)return;
    if(!settings.telegram_user_id&&(!pending.has(owner)||pending.get(owner)!.expires<Date.now()))return;
    const secret=token(owner);
    const updates=await telegramCall(secret,'getUpdates',{offset:settings.telegram_offset,timeout:0,limit:20,allowed_updates:['message','callback_query']});
    errors.delete(owner);
    for(const update of updates) {
      settings=agentSettings(owner);if(!settings?.telegram_username||!settings.enabled)break;
      if(!Number.isSafeInteger(update.update_id)||update.update_id<settings.telegram_offset)continue;
      const message=update.message;
      const callback=update.callback_query;
      if(callback&&settings.telegram_user_id) {
        const permitted=callback.message?.chat?.type==='private'&&String(callback.from?.id)===settings.telegram_user_id&&String(callback.message.chat.id)===settings.telegram_chat_id;
        const match=String(callback.data??'').match(/^qa:([0-9a-f-]{36}):(yes|no)$/);
        if(permitted&&match) {
          const state=myAgentState(owner),approval=state.approvals.find(a=>a.id===match[1]);
          if(approval&&approval.expires>Date.now()&&approval.method==='item/commandExecution/requestApproval') {
            await myAgentAction(owner,{action:'approve',id:approval.id,accept:match[2]==='yes'});
            await telegramCall(secret,'answerCallbackQuery',{callback_query_id:callback.id,text:'Qoopia: saved'});
          }else await telegramCall(secret,'answerCallbackQuery',{callback_query_id:callback.id,text:'Request expired or already answered'});
        }
        db.query('UPDATE qoopia_agent_settings SET telegram_offset=? WHERE owner_id=?').run(update.update_id+1,owner);continue;
      }
      if(!settings.telegram_user_id) {
        const p=pending.get(owner),code=message?.text?.match(/^\/start ([A-Za-z0-9_-]{32})$/)?.[1];
        if(p&&p.expires>Date.now()&&!p.user&&code&&hash(code)===p.digest&&message.chat?.type==='private'&&!message.from?.is_bot)
          p.user={id:String(message.from.id),chat:String(message.chat.id),name:[message.from.first_name,message.from.last_name].filter(Boolean).join(' ').slice(0,120)};
      } else if(isBoundTelegramMessage(settings,message)&&typeof message.text==='string') {
        try {
        const text=message.text.trim();
        let state=myAgentState(owner);
        if(text==='/stop')await myAgentAction(owner,{action:'stop'});
        else if(text==='/new')await myAgentAction(owner,{action:'new',title:'Telegram'});
        else if(text&&!text.startsWith('/')) {
          if(!state.account)throw new QoopiaError('NOT_READY','Sign in to your selected subscription in the dashboard first');
          if(!state.selected||state.selected_provider!==state.provider){const c=await myAgentAction(owner,{action:'new',title:text.slice(0,80)});state=myAgentState(owner,c.id);}
          const result=await myAgentAction(owner,{action:'send',conversation:state.selected,requestId:'telegram:'+update.update_id,text:text.slice(0,16_000)});
          db.query("INSERT OR IGNORE INTO qoopia_agent_telegram_delivery(run_id,state) VALUES(?,'pending')").run(result.id);
        }
        }catch{
          // A rejected message must not block later messages, especially /stop. Never replay it.
          db.query('UPDATE qoopia_agent_settings SET telegram_offset=? WHERE owner_id=?').run(update.update_id+1,owner);
          errors.set(owner,'Telegram message was not started. Review sign-in or the current task, then send your message again.');
          await telegramCall(secret,'sendMessage',{chat_id:settings.telegram_chat_id,text:'Сообщение не запущено. Проверьте вход и текущую задачу в дашборде, затем отправьте его снова. / Message not started. Check sign-in and the current task in your dashboard, then send it again.'});
        }
      }
      db.query('UPDATE qoopia_agent_settings SET telegram_offset=? WHERE owner_id=?').run(update.update_id+1,owner);
    }
    settings=agentSettings(owner);
    if(settings?.telegram_chat_id) {
      const current=myAgentState(owner),notified=approvalNotices.get(owner)??new Set<string>();approvalNotices.set(owner,notified);
      for(const approval of current.approvals) {
        if(notified.has(approval.id))continue;
        const simple=approval.method==='item/commandExecution/requestApproval';
        // File patches and permission grants require the complete dashboard preview.
        const text=simple?'Qoopia: разрешить команду один раз? / Allow this command once?\n\n'+String(approval.params.command??approval.params.reason??'').slice(0,2800):'Qoopia: нужен ваш ответ или проверка доступа в дашборде. / Review this request in your dashboard.';
        await telegramCall(secret,'sendMessage',{chat_id:settings.telegram_chat_id,text,...(simple?{reply_markup:{inline_keyboard:[[{text:'Разрешить / Allow',callback_data:'qa:'+approval.id+':yes'},{text:'Отклонить / Decline',callback_data:'qa:'+approval.id+':no'}]]}}:{})});
        notified.add(approval.id);
      }
      for(const id of notified)if(!current.approvals.some(a=>a.id===id))notified.delete(id);
      const deliveries=db.query(`SELECT r.id,r.answer,r.state FROM qoopia_agent_telegram_delivery d JOIN qoopia_agent_runs r ON r.id=d.run_id
        JOIN qoopia_agent_conversations c ON c.id=r.conversation_id WHERE c.owner_id=? AND d.state='pending' AND r.state IN ('completed','interrupted','failed')`).all(owner) as {id:string;answer:string;state:string}[];
      for(const run of deliveries) {
        // Mark before delivery. An ambiguous transport failure is surfaced, never blindly replayed.
        db.query("UPDATE qoopia_agent_telegram_delivery SET state='sending' WHERE run_id=?").run(run.id);
        try {
          const text=run.answer||'Задача остановлена. Подробности в дашборде. / Task stopped. See your dashboard.';
          const result=await telegramCall(secret,'sendMessage',{chat_id:settings.telegram_chat_id,text:text.length>4000?text.slice(0,3800)+'\n\nПолный ответ в дашборде. / Full answer in your dashboard.':text});
          db.query("UPDATE qoopia_agent_telegram_delivery SET state='sent',message_id=? WHERE run_id=?").run(result.message_id,run.id);
          if(run.state==='completed'&&run.answer)db.query('UPDATE qoopia_agent_settings SET telegram_verified=1 WHERE owner_id=?').run(owner);
        }catch(error){db.query("UPDATE qoopia_agent_telegram_delivery SET state='uncertain' WHERE run_id=?").run(run.id);throw error;}
      }
    }
  }catch{errors.set(owner,'Telegram needs attention. Open My Qoopia agent to check sign-in, pending approvals or bot connection.');}
  finally{polling.delete(owner);}
}
export function startTelegramChannels() {
  if(timer)return;
  db.query("UPDATE qoopia_agent_telegram_delivery SET state='uncertain' WHERE state='sending'").run();
  timer=setInterval(()=>{
    const owners=db.query('SELECT owner_id FROM qoopia_agent_settings WHERE enabled=1 AND telegram_username IS NOT NULL').all() as {owner_id:string}[];
    for(const {owner_id} of owners)void pollTelegramOwner(owner_id);
  },2500);timer.unref();
}
export function stopTelegramChannels(){if(timer)clearInterval(timer);timer=undefined;}
