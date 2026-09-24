import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {db} from '../db/connection.ts';
import {durableWrite,readJsonBytes,hash} from '../utils/fs.ts';
import {agentDirectory,agentOwner,agentSettings,myAgentAction,telegramAgentState,unsavedTurn,type AgentSettings} from './my-agent.ts';
import {assertNoSecrets} from '../utils/secret-guard.ts';
import {canManagePolicy,pendingSave} from './memory-policy.ts';
import {decideSaveRequest,listSaveRequests} from './memory-save-requests.ts';
import {QoopiaError} from '../utils/errors.ts';
import {channel,ensureChannel,queueTelegram,acknowledgeTelegram,recoverTelegram,telegramChunks,TELEGRAM_WAITING_LOGIN,TELEGRAM_LOGIN_REQUIRED,resumeTelegramAfterLogin,scrubTelegramTransit} from './telegram-store.ts';

type Pending={digest:string;code:string;expires:number;user?:{id:string;chat:string;name:string}};
// Pairing survives process/page restarts. Tokens remain in the private token file.
const pending={
 get(owner:string):Pending|undefined {const c=channel(owner);return c?.pairing_code?{digest:hash(c.pairing_code),code:c.pairing_code,expires:c.pairing_expires!,...(c.candidate_id?{user:{id:c.candidate_id,chat:c.candidate_chat!,name:c.candidate_name!}}:{})}:undefined;},
 has(owner:string){return !!channel(owner)?.pairing_code;},
 set(owner:string,p:Pending){ensureChannel(owner);db.query('UPDATE qoopia_telegram_channels SET pairing_code=?,pairing_expires=?,candidate_id=?,candidate_chat=?,candidate_name=? WHERE owner_id=?').run(p.code,p.expires,p.user?.id??null,p.user?.chat??null,p.user?.name??null,owner);},
 delete(owner:string){db.query('UPDATE qoopia_telegram_channels SET pairing_code=NULL,pairing_expires=NULL,candidate_id=NULL,candidate_chat=NULL,candidate_name=NULL WHERE owner_id=?').run(owner);}
};
const polling=new Set<string>(),workers=new Set<string>(),deliverers=new Set<string>();
const polls=new Map<string,AbortController>(),typingAt=new Map<string,number>();
const errors={get:(owner:string)=>channel(owner)?.error,set:(owner:string,error:string)=>{ensureChannel(owner);db.query('UPDATE qoopia_telegram_channels SET error=? WHERE owner_id=?').run(error,owner);},delete:(owner:string)=>db.query('UPDATE qoopia_telegram_channels SET error=NULL WHERE owner_id=?').run(owner)};
const setupBusy=new Set<string>();
let timer:ReturnType<typeof setInterval>|undefined;
const tokenFile=(owner:string)=>path.join(agentDirectory(owner),'telegram.json');
const token=(owner:string)=>(JSON.parse(readJsonBytes(tokenFile(owner)).toString()) as {token:string}).token;
/** Never include Telegram URLs or descriptions: they may contain the bot token. */
export class TelegramError extends QoopiaError {
  constructor(readonly status:number,readonly retryAfter:number=0){
    super('NOT_READY',status===409?'Telegram polling conflict: another host is using this bot.':status===401?'Telegram token was refused. Reconnect the bot.':status===429?'Telegram rate limit. Retrying after its cooldown.':'Telegram did not accept the request. Check the token, network and other bot connections.');
  }
}
export async function telegramCall(secret:string,method:string,body:unknown,signal?:AbortSignal):Promise<any> {
  try {
    const timeout=AbortSignal.timeout(method==='getUpdates'?30_000:15_000);
    const response=await fetch('https://api.telegram.org/bot'+secret+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([timeout,signal]):timeout,redirect:'error'});
    const result=await response.json() as any;
    if(!response.ok||!result.ok)throw new TelegramError(Number(result.error_code)||response.status,Math.min(86400,Math.max(1,Number(result.parameters?.retry_after)||1))*1000);
    return result.result;
  }catch(error){if(error instanceof TelegramError)throw error;throw new TelegramError(0);}
}
export function telegramState(owner:string){
  agentOwner(owner);const p=pending.get(owner),c=channel(owner),settings=agentSettings(owner);
  const count=(sql:string)=>Number((db.query(sql).get(owner,c?.generation??'') as {n:number}).n);
  return {
    pending:p&&p.expires>Date.now()?{expires:p.expires,user:p.user??null,url:'https://t.me/'+settings?.telegram_username+'?start='+p.code}:null,
    expired:!!settings?.telegram_username&&!settings?.telegram_user_id&&(!p||p.expires<=Date.now()),
    queued:count("SELECT COUNT(*) n FROM qoopia_telegram_inbox WHERE owner_id=? AND generation=? AND state='queued'"),
    error:c?.error??null,last_poll_at:c?.last_poll_at??null,
    uncertain_deliveries:count("SELECT COUNT(*) n FROM qoopia_telegram_outbox WHERE owner_id=? AND generation=? AND state='uncertain'")+
      count("SELECT COUNT(*) n FROM qoopia_agent_telegram_delivery d JOIN qoopia_agent_runs r ON r.id=d.run_id JOIN qoopia_agent_conversations c ON c.id=r.conversation_id WHERE c.owner_id=? AND d.generation=? AND d.state='uncertain' AND NOT EXISTS(SELECT 1 FROM qoopia_telegram_outbox o WHERE o.run_id=d.run_id)"),
  };
}
const actionSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('telegram-connect'),token:z.string().trim().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/)}).strict(),
  z.object({action:z.literal('telegram-retry')}).strict(),
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
    if(settings.telegram_username)throw new QoopiaError('CONFLICT','Disconnect the current bot before changing it');
    const [bot,webhook]=await Promise.all([telegramCall(input.token,'getMe',{}),telegramCall(input.token,'getWebhookInfo',{})]);
    if(!bot.is_bot||!/^\w{5,32}$/.test(bot.username??''))throw new QoopiaError('INVALID_INPUT','Telegram bot has no valid username');
    if(webhook.url)throw new QoopiaError('CONFLICT','This bot has a webhook. Use a separate bot or disconnect its current application.');
    if(db.query('SELECT owner_id FROM qoopia_agent_settings WHERE telegram_username=? AND owner_id<>?').get(bot.username,owner))throw new QoopiaError('CONFLICT','This bot is already connected to another owner in this installation');
    durableWrite(tokenFile(owner),JSON.stringify({token:input.token}));
    ensureChannel(owner);
    db.query('UPDATE qoopia_telegram_channels SET generation=?,bot_id=?,conversation_id=NULL,paused=0,retry_at=0,failures=0 WHERE owner_id=?').run(randomBytes(16).toString('hex'),String(bot.id??input.token.split(':')[0]),owner);
    const code=randomBytes(24).toString('base64url');pending.set(owner,{code,digest:hash(code),expires:Date.now()+600_000});
    db.query("UPDATE qoopia_agent_settings SET channel='telegram',telegram_username=?,telegram_offset=0,telegram_verified=0 WHERE owner_id=?").run(bot.username,owner);
    errors.delete(owner);startTelegramChannels();return {url:'https://t.me/'+bot.username+'?start='+code};
  }
  if(input.action==='telegram-retry') {
    if(!settings.telegram_username||settings.telegram_user_id)throw new QoopiaError('CONFLICT','This bot does not need pairing');
    const code=randomBytes(24).toString('base64url');pending.set(owner,{code,digest:hash(code),expires:Date.now()+600_000});errors.delete(owner);
    return {url:'https://t.me/'+settings.telegram_username+'?start='+code};
  }
  if(input.action==='telegram-confirm') {
    if(settings.telegram_user_id===input.userId&&settings.telegram_chat_id===input.chatId)return {linked:true};
    const p=pending.get(owner);
    if(!p||p.expires<Date.now()||!p.user||p.user.id!==input.userId||p.user.chat!==input.chatId)throw new QoopiaError('CONFLICT','Link expired or account changed. Create a fresh pairing link.');
    db.transaction(()=>{
      db.query('UPDATE qoopia_agent_settings SET telegram_user_id=?,telegram_chat_id=? WHERE owner_id=?').run(input.userId,input.chatId,owner);
      queueTelegram(owner,ensureChannel(owner).generation,'linked',{chat_id:input.chatId,text:'Qoopia подключена. Напишите агенту. /stop — остановить задачу и очередь; /new — новый разговор. / Connected. Send a message. /stop stops the task and queue; /new starts a conversation.'});
      pending.delete(owner);
      db.query("UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE owner_id=? AND state='queued' AND delivery_key LIKE 'pair:%'").run(owner);
    }).immediate();
    return {linked:true};
  }
  polls.get(owner)?.abort();pending.delete(owner);errors.delete(owner);
  db.query("UPDATE qoopia_telegram_inbox SET state='cancelled' WHERE owner_id=? AND state='queued'").run(owner);
  db.query("UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE owner_id=? AND state='queued'").run(owner);
  db.query('UPDATE qoopia_telegram_channels SET generation=?,paused=1 WHERE owner_id=?').run(randomBytes(16).toString('hex'),owner);
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
  if(polling.has(owner)||setupBusy.has(owner)||(channel(owner)?.retry_at??0)>Date.now())return;polling.add(owner);
  const controller=new AbortController();polls.set(owner,controller);let generation='';
  try {
    let settings=agentSettings(owner);if(!settings?.enabled||!settings.telegram_username)return;
    const binding=ensureChannel(owner);generation=binding.generation;
    const secret=token(owner);
    const updates=await telegramCall(secret,'getUpdates',{offset:settings.telegram_offset,timeout:20,limit:20,allowed_updates:['message','callback_query']},controller.signal);
    db.query('UPDATE qoopia_telegram_channels SET last_poll_at=?,error=CASE WHEN failures>0 THEN NULL ELSE error END,failures=0,retry_at=0 WHERE owner_id=? AND generation=?').run(Date.now(),owner,generation);
    for(const update of updates) {
      settings=agentSettings(owner);if(!settings?.telegram_username||!settings.enabled||channel(owner)?.generation!==generation)break;
      if(!Number.isSafeInteger(update.update_id)||update.update_id<settings.telegram_offset)continue;
      const message=update.message;
      const callback=update.callback_query;
      if(callback&&settings.telegram_user_id) {
        const permitted=callback.message?.chat?.type==='private'&&String(callback.from?.id)===settings.telegram_user_id&&String(callback.message.chat.id)===settings.telegram_chat_id;
        const match=String(callback.data??'').match(/^qa:([0-9a-f-]{36}):(yes|no)$/);
        const saveMatch=String(callback.data??'').match(/^qs:([0-9A-HJKMNP-TV-Z]{26}):(yes|no)$/);
        if(permitted&&saveMatch) {
          // The owner decides here through the same writer the dashboard uses: one use, one decision.
          try {
            const decision=decideSaveRequest({workspace_id:settings.workspace_id,actor_id:settings.owner_id,id:saveMatch[1],accept:saveMatch[2]==='yes'});
            await telegramCall(secret,'answerCallbackQuery',{callback_query_id:callback.id,text:decision.state==='saved'?'Qoopia: saved':'Qoopia: declined'});
          }catch(error) {
            const code=error instanceof QoopiaError?error.code:'';
            await telegramCall(secret,'answerCallbackQuery',{callback_query_id:callback.id,
              text:code==='NOT_FOUND'||code==='CONFLICT'?'Request expired or already answered':'Qoopia could not apply this decision'});
          }
        }
        else if(permitted&&match) {
          const state=telegramAgentState(owner),approval=state.approvals.find(a=>a.id===match[1]);
          if(approval&&approval.expires>Date.now()&&simpleTelegramApproval(approval)) {
            await myAgentAction(owner,{action:'approve',id:approval.id,accept:match[2]==='yes'});
            await telegramCall(secret,'answerCallbackQuery',{callback_query_id:callback.id,text:'Qoopia: saved'});
          }else await telegramCall(secret,'answerCallbackQuery',{callback_query_id:callback.id,text:'Request expired or already answered'});
        }
        acknowledgeTelegram(owner,generation,update.update_id);continue;
      }
      if(!settings.telegram_user_id) {
        const p=pending.get(owner),code=message?.text?.match(/^\/start ([A-Za-z0-9_-]{32})$/)?.[1];
        if(p&&p.expires>Date.now()&&!p.user&&code&&hash(code)===p.digest&&message.chat?.type==='private'&&!message.from?.is_bot)
          {p.user={id:String(message.from.id),chat:String(message.chat.id),name:[message.from.first_name,message.from.last_name].filter(Boolean).join(' ').slice(0,120)};pending.set(owner,p);}
        if(message?.chat?.type==='private'&&!message.from?.is_bot){
          queueTelegram(owner,generation,'pair:'+message.chat.id+':'+Math.floor(Date.now()/600000)+(p&&p.expires>Date.now()&&p.user?.id===String(message.from?.id)?':confirm':''),{chat_id:message.chat.id,text:p&&p.expires>Date.now()&&p.user?.id===String(message.from?.id)?'Подтвердите «Это мой аккаунт» в Qoopia. / Confirm “This is my account” in Qoopia.':'Для привязки откройте Qoopia → Telegram и используйте ссылку «Открыть бота». / Use the pairing link in Qoopia → Telegram.'});
        }
      } else if(isBoundTelegramMessage(settings,message)&&typeof message.text==='string') {
        const text=message.text.trim();
        try {
        const state=telegramAgentState(owner);
        if(text==='/stop'){await myAgentAction(owner,{action:'stop'});queueTelegram(owner,generation,'stop:'+update.update_id,{chat_id:settings.telegram_chat_id,text:'Задача и очередь остановлены. / Task and queue stopped.'});}
        else if(text==='/new'){
          if(workers.has(owner)||state.active_conversation||telegramState(owner).queued)throw new QoopiaError('CONFLICT','Stop the current task and queue before starting a new conversation.');
          const created=await myAgentAction(owner,{action:'new',title:'Telegram'});
          db.query('UPDATE qoopia_telegram_channels SET conversation_id=? WHERE owner_id=? AND generation=?').run(created.id,owner,generation);
          queueTelegram(owner,generation,'new:'+update.update_id,{chat_id:settings.telegram_chat_id,text:'Новый разговор создан. / New conversation ready.'});
        }
        else if(text==='/status'||text==='/start'||text==='/help')queueTelegram(owner,generation,'status:'+update.update_id,{chat_id:settings.telegram_chat_id,text:(state.approvals.length?'Нужен ваш ответ. Проверьте запрос разрешения. / Waiting for your approval.':state.active_conversation?'Агент работает. / Agent is working.':!state.account?'Для выполнения задач войдите в подписку в Qoopia. / Sign in to your subscription in Qoopia.':'Готов принять задачу. / Ready for a task.')+' /stop — остановить, /new — новый разговор.'});
        else if(text&&!text.startsWith('/')) {
          assertNoSecrets(text,'Telegram message');
          db.transaction(()=>{
            const queued=(db.query("SELECT COUNT(*) n FROM qoopia_telegram_inbox WHERE owner_id=? AND generation=? AND state='queued'").get(owner,generation) as {n:number}).n;
            if(queued>=50||text.length>16000)queueTelegram(owner,generation,'refused:'+update.update_id,{chat_id:settings!.telegram_chat_id,text:'Сообщение не принято: очередь заполнена или текст длиннее 16000 символов. / Message not accepted: queue full or text exceeds 16000 characters.'});
            else {
              db.query('INSERT OR IGNORE INTO qoopia_telegram_inbox(owner_id,generation,update_id,prompt,provider,created_at) VALUES(?,?,?,?,?,?)').run(owner,generation,update.update_id,text,settings!.provider,Date.now());
              if((db.query("SELECT state FROM qoopia_telegram_inbox WHERE owner_id=? AND generation=? AND update_id=?").get(owner,generation,update.update_id) as {state:string}|null)?.state==='queued')db.query('UPDATE qoopia_telegram_channels SET paused=0 WHERE owner_id=?').run(owner);
              queueTelegram(owner,generation,'accepted:'+update.update_id,{chat_id:settings!.telegram_chat_id,text:'Принято. / Received.'});
            }
            acknowledgeTelegram(owner,generation,update.update_id);
          }).immediate();
        }
        }catch(error){
          // Storage failures must not acknowledge an update that was never saved.
          if(!(error instanceof QoopiaError))throw error;
          queueTelegram(owner,generation,'refused:'+update.update_id,{chat_id:settings.telegram_chat_id,text:text==='/new'?'Сначала остановите текущую задачу и очередь: /stop. Затем повторите /new. / Use /stop before /new.':'Команда не выполнена. Проверьте состояние в Qoopia. / Command failed. Check Qoopia.'});
        }
      }
      acknowledgeTelegram(owner,generation,update.update_id);
    }
  }catch(error){
    if(!controller.signal.aborted&&generation&&channel(owner)?.generation===generation){
      const c=channel(owner)!;const delay=error instanceof TelegramError&&error.status===429?error.retryAfter:Math.min(60000,1000*2**Math.min(c.failures,6));
      db.query('UPDATE qoopia_telegram_channels SET error=?,failures=failures+1,retry_at=? WHERE owner_id=? AND generation=?').run(error instanceof TelegramError?error.message:'Telegram could not save a message. Retrying without acknowledging it.',Date.now()+delay,owner,generation);
    }
  }finally{polling.delete(owner);if(polls.get(owner)===controller)polls.delete(owner);}

}
/** The provider can take seconds to start. This worker never holds the polling lock. */
export async function runTelegramQueue(owner:string){
  const s=agentSettings(owner),c=channel(owner);
  if(!s?.enabled||!s.telegram_chat_id||!c||c.paused===1||workers.has(owner)||setupBusy.has(owner))return;
  const state=telegramAgentState(owner);
  if(state.active_conversation||(c.paused===TELEGRAM_WAITING_LOGIN&&state.running&&!state.account))return;
  if(c.paused===TELEGRAM_WAITING_LOGIN&&state.account)resumeTelegramAfterLogin(owner);
  const row=db.query("SELECT update_id,prompt,provider FROM qoopia_telegram_inbox WHERE owner_id=? AND generation=? AND state='queued' ORDER BY update_id LIMIT 1").get(owner,c.generation) as {update_id:number;prompt:string;provider:string}|null;
  if(!row)return;workers.add(owner);
  try{
    if(row.provider!==s.provider){
      db.query("UPDATE qoopia_telegram_inbox SET state='failed' WHERE owner_id=? AND generation=? AND update_id=? AND state='queued'").run(owner,c.generation,row.update_id);
      queueTelegram(owner,c.generation,'provider:'+row.update_id,{chat_id:s.telegram_chat_id,text:'Подписка изменилась до запуска сообщения. Оно не выполнялось. Выберите нужную подписку и отправьте его заново. / Subscription changed before this message started. It was not executed. Select your subscription and resend.'});return;
    }
    if(!telegramAgentState(owner).account){
      await myAgentAction(owner,{action:'start'});
      if(channel(owner)?.generation!==c.generation||channel(owner)?.paused===1)return;
      if(!telegramAgentState(owner).account){
        db.query('UPDATE qoopia_telegram_channels SET paused=? WHERE owner_id=? AND generation=?').run(TELEGRAM_WAITING_LOGIN,owner,c.generation);
        errors.set(owner,TELEGRAM_LOGIN_REQUIRED);
        queueTelegram(owner,c.generation,'login:'+row.update_id,{chat_id:s.telegram_chat_id,text:'Войдите в подписку в Qoopia. Сохранённые задачи продолжатся после входа. / Sign in to your subscription in Qoopia. Your saved tasks will continue after sign-in.'});return;
      }
    }
    if(channel(owner)?.generation!==c.generation||channel(owner)?.paused)return;
    let conversation=c.conversation_id;
    const existing=conversation?db.query('SELECT provider FROM qoopia_agent_conversations WHERE id=? AND owner_id=?').get(conversation,owner) as {provider:string}|null:null;
    if(!existing||existing.provider!==s.provider){
      const created=await myAgentAction(owner,{action:'new',title:'Telegram'});
      if(channel(owner)?.generation!==c.generation||channel(owner)?.paused)return;
      conversation=created.id;db.query('UPDATE qoopia_telegram_channels SET conversation_id=? WHERE owner_id=?').run(conversation,owner);
    }
    db.query("UPDATE qoopia_telegram_inbox SET state='starting' WHERE owner_id=? AND generation=? AND update_id=? AND state='queued'").run(owner,c.generation,row.update_id);
    await myAgentAction(owner,{action:'send',conversation,requestId:'tg:'+c.generation+':'+row.update_id,text:row.prompt},{generation:c.generation,updateId:row.update_id});
    queueTelegram(owner,c.generation,'working:'+row.update_id,{chat_id:s.telegram_chat_id,text:'Агент начал работу. / Agent started working.'});
  }catch(error){
    if(error instanceof QoopiaError&&error.code==='CONFLICT')db.query("UPDATE qoopia_telegram_inbox SET state='queued' WHERE owner_id=? AND generation=? AND update_id=? AND state='starting' AND run_id IS NULL").run(owner,c.generation,row.update_id);
    else{
      const failed=db.query("UPDATE qoopia_telegram_inbox SET state='failed' WHERE owner_id=? AND generation=? AND update_id=? AND run_id IS NULL AND state IN ('queued','starting')").run(owner,c.generation,row.update_id);
      if(failed.changes)queueTelegram(owner,c.generation,'failed:'+row.update_id,{chat_id:s.telegram_chat_id,text:'Не удалось начать задачу. Проверьте подписку в Qoopia. Автоматического повтора не будет. / Task could not start. Check your subscription in Qoopia. It will not be replayed automatically.'});
    }
  }finally{workers.delete(owner);}
}
export function simpleTelegramApproval(a:{method:string;params:any}){return a.method==='item/commandExecution/requestApproval'&&typeof a.params.command==='string'&&a.params.command.length<=2800&&(!a.params.tool||a.params.tool==='Bash');}
export async function deliverTelegram(owner:string){
  if(deliverers.has(owner)||setupBusy.has(owner))return;
  const binding=channel(owner),settings=agentSettings(owner);
  if(!binding||!settings?.enabled||!settings.telegram_username)return;
  deliverers.add(owner);const generation=binding.generation;
  const currentBinding=()=>channel(owner)?.generation===generation&&!!agentSettings(owner)?.telegram_username;
  try{
    if(settings.telegram_chat_id){
      const current=telegramAgentState(owner);
      for(const approval of current.approvals){
        const simple=simpleTelegramApproval(approval);
        const text=simple?'Qoopia: разрешить команду один раз? / Allow this command once?\n\n'+approval.params.command:'Qoopia: нужен ваш ответ в дашборде. / Review this request in your dashboard.';
        queueTelegram(owner,generation,'approval:'+approval.id,{chat_id:settings.telegram_chat_id,text,...(simple?{reply_markup:{inline_keyboard:[[{text:'Разрешить / Allow',callback_data:'qa:'+approval.id+':yes'},{text:'Отклонить / Decline',callback_data:'qa:'+approval.id+':no'}]]}}:{})},approval.run_id);
      }
      // A manual agent's prepared save reaches the owner here. Only the owner of this workspace sees
      // the material, and the delivery key sends each request once however often this loop runs.
      if(canManagePolicy(settings.workspace_id,settings.owner_id))
        for(const request of listSaveRequests(settings.workspace_id,settings.owner_id)) {
          const material=(request.text??'').slice(0,2800);
          queueTelegram(owner,generation,'save:'+request.id,{chat_id:settings.telegram_chat_id,
            text:'Qoopia: сохранить это в память? / Save this to memory?\n\n'+request.agent+':\n'+material,
            reply_markup:{inline_keyboard:[[{text:'Сохранить / Save',callback_data:'qs:'+request.id+':yes'},{text:'Отклонить / Decline',callback_data:'qs:'+request.id+':no'}]]}});
        }
      // Persist every chunk before sending. A restart cannot repeat already sent chunks.
      const deliveries=db.query(`SELECT r.id,r.prompt,r.answer,r.state FROM qoopia_agent_telegram_delivery d JOIN qoopia_agent_runs r ON r.id=d.run_id
        JOIN qoopia_agent_conversations c ON c.id=r.conversation_id WHERE c.owner_id=? AND d.generation=? AND d.state='pending' AND r.state IN ('completed','interrupted','failed')`).all(owner,generation) as {id:string;prompt:string;answer:string;state:string}[];
      db.transaction(()=>{
        for(const run of deliveries){
          // A manual agent's reply exists only in this process; after a restart there is nothing to send.
          if(!run.prompt)run.answer=unsavedTurn(run.id)?.answer??(run.state==='completed'?'Ответ не сохранён: Qoopia перезапущена, а агент сохраняет только по команде. Повторите запрос. / The reply was not kept: Qoopia restarted and this agent saves only on request. Please ask again.':'');
          const text=run.state==='completed'?(run.answer||'Задача завершена без текстового ответа. / Task completed without a text reply.'):(run.state==='interrupted'?'Задача остановлена. / Task stopped.':'Задача завершилась с ошибкой. Подробности в Qoopia. / Task failed. See Qoopia.')+(run.answer?'\n\n'+run.answer:'');
          telegramChunks(text).forEach((chunk,i)=>queueTelegram(owner,generation,'run:'+run.id+':'+i,{chat_id:settings.telegram_chat_id,text:chunk},run.id));
          db.query("UPDATE qoopia_telegram_inbox SET state=? WHERE run_id=?").run(run.state==='completed'?'done':run.state==='interrupted'?'cancelled':'failed',run.id);
        }
      }).immediate();
      if(current.active_conversation&&Date.now()-(typingAt.get(owner)??0)>4000){
        typingAt.set(owner,Date.now());
        void telegramCall(token(owner),'sendChatAction',{chat_id:settings.telegram_chat_id,action:'typing'}).catch(()=>{});
      }
    }
    const outbound=db.query("SELECT id,body,delivery_key,run_id FROM qoopia_telegram_outbox WHERE owner_id=? AND generation=? AND state='queued' ORDER BY id LIMIT 5").all(owner,generation) as {id:number;body:string;delivery_key:string;run_id:string|null}[];
    for(const item of outbound){
      if(!currentBinding())return;
      const retry=db.query('SELECT retry_at FROM qoopia_telegram_outbox WHERE id=?').get(item.id) as {retry_at:number};if(retry.retry_at>Date.now())break;
      if(item.delivery_key.startsWith('approval:')&&!telegramAgentState(owner).approvals.some(a=>a.id===item.delivery_key.slice(9))){db.query("UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE id=?").run(item.id);continue;}
      // A prepared save that expired or was already decided must not arrive with live buttons.
      if(item.delivery_key.startsWith('save:')&&!pendingSave(settings.workspace_id,item.delivery_key.slice(5))){db.query("UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE id=?").run(item.id);continue;}
      db.query("UPDATE qoopia_telegram_outbox SET state='sending' WHERE id=?").run(item.id);
      try{
        const sent=await telegramCall(token(owner),'sendMessage',JSON.parse(item.body));
        db.query("UPDATE qoopia_telegram_outbox SET state='sent',message_id=? WHERE id=?").run(sent.message_id,item.id);
      }catch(error){
        // Only explicit 429 is safely retryable. Network loss after send is ambiguous.
        const retryable=error instanceof TelegramError&&error.status===429;
        db.query('UPDATE qoopia_telegram_outbox SET state=?,retry_at=? WHERE id=?').run(retryable?'queued':'uncertain',retryable?Date.now()+error.retryAfter:0,item.id);
        if(!retryable&&item.run_id)db.query("UPDATE qoopia_telegram_outbox SET state='cancelled' WHERE run_id=? AND state='queued'").run(item.run_id);
        throw error;
      }
    }
    reconcileTelegramDeliveries(owner,generation);
  }catch(error){
    if(currentBinding()){reconcileTelegramDeliveries(owner,generation);errors.set(owner,error instanceof TelegramError?error.message:'Telegram delivery needs attention. Your answer is saved in Qoopia.');}
  }finally{deliverers.delete(owner);try{scrubTelegramTransit(owner);}catch{}}
}
function reconcileTelegramDeliveries(owner:string,generation:string){
  const rows=db.query(`SELECT d.run_id,r.state,r.answer FROM qoopia_agent_telegram_delivery d JOIN qoopia_agent_runs r ON r.id=d.run_id JOIN qoopia_agent_conversations c ON c.id=r.conversation_id WHERE c.owner_id=? AND d.generation=? AND d.state='pending'`).all(owner,generation) as {run_id:string;state:string;answer:string}[];
  for(const run of rows){
    const parts=db.query('SELECT state,message_id FROM qoopia_telegram_outbox WHERE run_id=? AND generation=?').all(run.run_id,generation) as {state:string;message_id:number|null}[];
    const state=parts.some(p=>p.state==='uncertain')?'uncertain':parts.length&&parts.every(p=>p.state==='sent')?'sent':null;
    if(!state)continue;
    db.query('UPDATE qoopia_agent_telegram_delivery SET state=?,message_id=? WHERE run_id=?').run(state,parts[0]?.message_id??null,run.run_id);
    if(state==='sent'&&run.state==='completed'&&(run.answer||unsavedTurn(run.run_id)?.answer))db.query('UPDATE qoopia_agent_settings SET telegram_verified=1 WHERE owner_id=? AND EXISTS(SELECT 1 FROM qoopia_telegram_channels WHERE owner_id=? AND generation=?)').run(owner,owner,generation);
  }
}
export function startTelegramChannels() {
  if(timer)return;
  recoverTelegram();
  timer=setInterval(()=>{
    const owners=db.query('SELECT owner_id FROM qoopia_agent_settings WHERE enabled=1 AND telegram_username IS NOT NULL').all() as {owner_id:string}[];
    for(const {owner_id} of owners)for(const task of [pollTelegramOwner,runTelegramQueue,deliverTelegram])void task(owner_id).catch(()=>{});
  },1000);timer.unref();
}
export function stopTelegramChannels(){if(timer)clearInterval(timer);timer=undefined;for(const controller of polls.values())controller.abort();}
