import {db} from '../db/connection.ts';
import {randomBytes} from 'node:crypto';

// paused: 0 = ready, 1 = explicitly stopped, 2 = waiting for subscription sign-in.
export const TELEGRAM_WAITING_LOGIN=2;
export const TELEGRAM_LOGIN_REQUIRED='Sign in to your subscription in Qoopia. Your saved tasks will continue after sign-in.';
export function resumeTelegramAfterLogin(owner:string){
  db.query('UPDATE qoopia_telegram_channels SET paused=0,error=CASE WHEN error IN (?,?) THEN NULL ELSE error END WHERE owner_id=? AND paused IN (0,?)').run(TELEGRAM_LOGIN_REQUIRED,'Sign in to your subscription in Qoopia, then send a message to continue.',owner,TELEGRAM_WAITING_LOGIN);
}
export type TelegramChannel={owner_id:string;generation:string;bot_id:string|null;pairing_code:string|null;pairing_expires:number|null;candidate_id:string|null;candidate_chat:string|null;candidate_name:string|null;conversation_id:string|null;paused:number;error:string|null;last_poll_at:number|null;retry_at:number;failures:number};
export function channel(owner:string){return db.query('SELECT * FROM qoopia_telegram_channels WHERE owner_id=?').get(owner) as TelegramChannel|null;}
export function ensureChannel(owner:string){
  db.query('INSERT OR IGNORE INTO qoopia_telegram_channels(owner_id,generation) VALUES(?,?)').run(owner,randomBytes(16).toString('hex'));
  return channel(owner)!;
}
export function queueTelegram(owner:string,generation:string,key:string,body:unknown,runId?:string){
  // The generation check fences replies from a disconnected or replaced bot.
  db.query(`INSERT OR IGNORE INTO qoopia_telegram_outbox(owner_id,generation,delivery_key,body,run_id)
    SELECT owner_id,generation,?,?,? FROM qoopia_telegram_channels WHERE owner_id=? AND generation=?`).run(key,JSON.stringify(body),runId??null,owner,generation);
}
export function acknowledgeTelegram(owner:string,generation:string,update:number){
  db.query(`UPDATE qoopia_agent_settings SET telegram_offset=MAX(telegram_offset,?) WHERE owner_id=?
    AND EXISTS(SELECT 1 FROM qoopia_telegram_channels WHERE owner_id=? AND generation=?)`).run(update+1,owner,owner,generation);
}
export function cancelTelegramQueue(owner:string){
  db.transaction(()=>{
    db.query("UPDATE qoopia_telegram_inbox SET state='cancelled' WHERE owner_id=? AND state IN ('queued','starting') AND run_id IS NULL").run(owner);
    db.query('UPDATE qoopia_telegram_channels SET paused=1 WHERE owner_id=?').run(owner);
    scrubTelegramTransit(owner);
  }).immediate();
}
export function recoverTelegram(){
  db.transaction(()=>{
    db.query("UPDATE qoopia_telegram_outbox SET state='uncertain' WHERE state='sending'").run();
    db.query("UPDATE qoopia_agent_telegram_delivery SET state='uncertain' WHERE state='sending'").run();
    // A crash around provider submission is ambiguous. Never replay the prompt.
    const interrupted=db.query(`SELECT i.owner_id,i.generation,i.update_id,s.telegram_chat_id FROM qoopia_telegram_inbox i JOIN qoopia_agent_settings s ON s.owner_id=i.owner_id WHERE i.state='starting' AND s.telegram_chat_id IS NOT NULL`).all() as {owner_id:string;generation:string;update_id:number;telegram_chat_id:string}[];
    for(const row of interrupted)queueTelegram(row.owner_id,row.generation,'restart:'+row.update_id,{chat_id:row.telegram_chat_id,text:'Qoopia перезапущена во время запуска задачи. Она не будет запущена повторно автоматически. Проверьте историю и отправьте новую команду. / Qoopia restarted during task submission. No automatic replay. Check history before sending a new command.'});
    db.query("UPDATE qoopia_telegram_inbox SET state='failed' WHERE state='starting'").run();
    db.query("UPDATE qoopia_telegram_inbox SET state='cancelled' WHERE state='running' AND run_id IN (SELECT id FROM qoopia_agent_runs WHERE state='interrupted')").run();
    scrubTelegramTransit();
  }).immediate();
}
/** Telegram counts UTF-16 characters; never split a surrogate pair. */
export function telegramChunks(text:string,limit=3900){
  const chunks:string[]=[];
  while(text.length){let end=Math.min(limit,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!))end--;chunks.push(text.slice(0,end));text=text.slice(end);}
  return chunks.length?chunks:['Task finished.'];
}
/** A manual agent's messages are transit state: once a reply is sent, or a message will never
 * start, the queue rows keep their delivery facts and lose the text. Driven by the agent's own
 * policy rather than by run linkage, so approval prompts, orphaned rows and rows left behind by
 * a disconnected channel are covered too. Called with no owner from the maintenance tick, so it
 * still runs when nobody is delivering anything. */
export function scrubTelegramTransit(owner?:string){
  const mine=(table:string)=>`(?1 IS NULL OR owner_id=?1) AND EXISTS(SELECT 1 FROM qoopia_agent_settings s
    JOIN agents a ON a.id=s.agent_id AND a.workspace_id=s.workspace_id
    WHERE s.owner_id=${table}.owner_id AND a.memory_mode='manual')`;
  db.query(`UPDATE qoopia_telegram_outbox SET body='{}' WHERE body<>'{}' AND state IN ('sent','cancelled','uncertain')
    AND ${mine('qoopia_telegram_outbox')}`).run(owner??null);
  db.query(`UPDATE qoopia_telegram_inbox SET prompt='' WHERE prompt<>'' AND state IN ('done','failed','cancelled')
    AND ${mine('qoopia_telegram_inbox')}`).run(owner??null);
}
