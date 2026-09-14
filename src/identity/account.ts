import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';

/** One identity for website profiles and installation enrollment; email proof is required by the caller. */
export function accounts(db:Database) {
  db.exec('CREATE TABLE IF NOT EXISTS connection_accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,google_sub TEXT UNIQUE)');
  db.exec('CREATE TABLE IF NOT EXISTS account_activity(account_id TEXT PRIMARY KEY,registered_at INTEGER,last_login_at INTEGER,login_count INTEGER NOT NULL DEFAULT 0)');
  return db.transaction((identity:{email:string;googleSub?:string})=>{
    const byEmail=db.query('SELECT id FROM connection_accounts WHERE email=?').get(identity.email) as {id:string}|null;
    const bySub=identity.googleSub?db.query('SELECT id FROM connection_accounts WHERE google_sub=?').get(identity.googleSub) as {id:string}|null:null;
    if(byEmail&&bySub&&byEmail.id!==bySub.id)throw new Error('ACCOUNT_CONFLICT');
    const id=bySub?.id??byEmail?.id??randomUUID();
    db.query('INSERT OR IGNORE INTO account_activity(account_id,registered_at) VALUES (?,?)').run(id,bySub||byEmail?null:Date.now());
    db.query(`INSERT INTO connection_accounts(id,email,google_sub) VALUES (?,?,?) ON CONFLICT(id)
      DO UPDATE SET email=excluded.email,google_sub=COALESCE(excluded.google_sub,connection_accounts.google_sub)`)
      .run(id,identity.email,identity.googleSub??null);
    return id;
  });
}
