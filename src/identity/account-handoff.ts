import type {Database} from 'bun:sqlite';
import {createHash,randomBytes} from 'node:crypto';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
type Account={email:string;google_sub?:string|null;url:string|null};
type Handoff={id:string;challenge:string;dashboard:string;expires:number;code_hash:string|null;email:string|null;google_sub:string|null};

/** A phone can navigate to a saved HTTPS workspace, never a credential or localhost URL. */
export function mobileDashboard(value:unknown):string|null {
  if(typeof value!=='string'||value.length>512)return null;
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['/','/dashboard'].includes(url.pathname)||
      ['localhost','localhost.','[::1]','0.0.0.0','qoopia.ai','www.qoopia.ai','auth.qoopia.ai'].includes(host)||
      host.startsWith('127.')||host.endsWith('.localhost')||(host.startsWith('c-')&&host.endsWith('.qoopia.ai')))return null;
    return new URL('/dashboard',url.origin).href;
  }catch{return null;}
}

/** One-use browser-delivered code + server-held verifier. Account cookies never leave the broker. */
export function accountHandoff(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_handoffs (
    id TEXT PRIMARY KEY,challenge TEXT NOT NULL,dashboard TEXT NOT NULL,expires INTEGER NOT NULL,
    code_hash TEXT,email TEXT,google_sub TEXT)`);
  const cleanup=()=>db.query('DELETE FROM account_handoffs WHERE expires<=?').run(Date.now());
  const get=(id:string)=>db.query('SELECT * FROM account_handoffs WHERE id=? AND expires>?').get(id,Date.now()) as Handoff|null;
  return {
    cleanup,get,
    start(challenge:string,address:unknown) {
      const dashboard=mobileDashboard(address);
      if(!dashboard||!/^[a-f0-9]{64}$/.test(challenge))throw new Error('Invalid account sign-in request');
      const id=secret();db.query('INSERT INTO account_handoffs(id,challenge,dashboard,expires) VALUES (?,?,?,?)').run(id,challenge,dashboard,Date.now()+600_000);
      return id;
    },
    authorize(id:string,account:Account) {
      const flow=get(id);
      // Only the address saved by this signed-in account is eligible for automatic continuation.
      if(!flow||mobileDashboard(account.url)!==flow.dashboard)throw new Error('WORKSPACE_MISMATCH');
      const code=secret();
      db.query('UPDATE account_handoffs SET code_hash=?,email=?,google_sub=? WHERE id=?').run(hash(code),account.email,account.google_sub??null,id);
      return flow.dashboard+'?signin=complete#account_code='+code;
    },
    redeem:db.transaction((id:string,verifier:string,code:unknown)=>{
      const flow=get(id);
      if(!flow||flow.challenge!==hash(verifier))throw new Error('Sign-in expired. Please start again');
      if(!code)return {pending:true as const};
      if(typeof code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(code)||!flow.code_hash||hash(code)!==flow.code_hash||!flow.email)throw new Error('Invalid account confirmation');
      db.query('DELETE FROM account_handoffs WHERE id=?').run(id);
      return {email:flow.email,...(flow.google_sub?{googleSub:flow.google_sub}:{})};
    }),
  };
}
