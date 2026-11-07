import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {hasColumn} from '../db/introspect.ts';

export type AccountIdentity={email:string;googleSub?:string;appleSub?:string};

/** One identity for website profiles and installation enrollment; email proof is required by the caller. */
export function accounts(db:Database) {
  db.exec('CREATE TABLE IF NOT EXISTS connection_accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,google_sub TEXT UNIQUE)');
  db.exec('CREATE TABLE IF NOT EXISTS account_activity(account_id TEXT PRIMARY KEY,registered_at INTEGER,last_login_at INTEGER,login_count INTEGER NOT NULL DEFAULT 0)');
  // Sign in with Apple: Apple's stable account identifier (its email may be a private relay address).
  if(!hasColumn(db,'connection_accounts','apple_sub'))db.exec('ALTER TABLE connection_accounts ADD COLUMN apple_sub TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS connection_accounts_apple_sub ON connection_accounts(apple_sub)');
  const find=(column:'email'|'google_sub'|'apple_sub',value:string|undefined)=>value?db.query(`SELECT id FROM connection_accounts WHERE ${column}=?`).get(value) as {id:string}|null:null;
  return db.transaction((identity:AccountIdentity)=>{
    const bySub=find('google_sub',identity.googleSub)??find('apple_sub',identity.appleSub),byEmail=find('email',identity.email);
    const matches=[bySub,byEmail,find('google_sub',identity.googleSub),find('apple_sub',identity.appleSub)].filter(row=>row!==null);
    if(new Set(matches.map(row=>row.id)).size>1)throw new Error('ACCOUNT_CONFLICT');
    const id=bySub?.id??byEmail?.id??randomUUID();
    db.query('INSERT OR IGNORE INTO account_activity(account_id,registered_at) VALUES (?,?)').run(id,bySub||byEmail?null:Date.now());
    db.query(`INSERT INTO connection_accounts(id,email,google_sub,apple_sub) VALUES (?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET email=excluded.email,google_sub=COALESCE(excluded.google_sub,connection_accounts.google_sub),apple_sub=COALESCE(excluded.apple_sub,connection_accounts.apple_sub)`)
      .run(id,identity.email,identity.googleSub??null,identity.appleSub??null);
    return id;
  });
}
