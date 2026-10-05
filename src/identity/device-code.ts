import type {Database} from 'bun:sqlite';
import {randomInt} from 'node:crypto';
import {hash} from '../utils/fs.ts';

/** RFC 8628 user codes: 8 characters without vowels or look-alikes (20^8, about 2.6e10), shown as XXXX-XXXX. */
const ALPHABET='BCDFGHJKLMNPQRSTVWXZ';
/** adds_device: the request carries a device key, so approving enrolls that installation in the account's external access. */
export type DeviceRequest={request_id:string;label:string;network:string|null;created:number;expires:number;adds_device:number};

/** Sign-in on another device: the installation holds the request verifier, the owner types the short code on a
 * device where they are signed in. Possession of the code, not the network, binds the confirmation, so this path
 * alone skips the F-125 network binding. A code is single-use, short-lived and lookups are rate-limited. */
export function deviceCodes(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS device_codes (request_id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL, network TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL)`);
  const normalize=(raw:unknown)=>{
    const code=typeof raw==='string'?raw.toUpperCase().replace(/[\s-]/g,''):'';
    return code.length===8&&[...code].every(c=>ALPHABET.includes(c))?code:null;
  };
  const cleanup=()=>db.query('DELETE FROM device_codes WHERE expires<=? OR request_id NOT IN (SELECT id FROM login_requests)').run(Date.now());
  const find=(raw:unknown):DeviceRequest|null=>{
    const code=normalize(raw);if(!code)return null;
    return db.query(`SELECT d.request_id,d.label,d.network,d.created,d.expires,r.device_peer IS NOT NULL AS adds_device FROM device_codes d JOIN login_requests r ON r.id=d.request_id
      WHERE d.code_hash=? AND d.expires>? AND r.confirmed=0`).get(hash(code),Date.now()) as DeviceRequest|null;
  };
  return {
    cleanup,find,
    start(requestId:string,label:string,network:string|null,expires:number) {
      for(;;){
        const code=Array.from({length:8},()=>ALPHABET[randomInt(ALPHABET.length)]).join('');
        try{
          db.query('INSERT INTO device_codes VALUES (?,?,?,?,?,?)').run(requestId,hash(code),label,network,Date.now(),expires);
          return code.slice(0,4)+'-'+code.slice(4);
        }catch(error){if(!String(error).includes('UNIQUE'))throw error;}
      }
    },
    /** One confirmation per code: the request becomes redeemable by the installation that holds its verifier. */
    approve:db.transaction((raw:unknown,identity:{email:string;google_sub?:string|null})=>{
      const flow=find(raw);if(!flow)return false;
      db.query('DELETE FROM device_codes WHERE request_id=?').run(flow.request_id);
      return db.query('UPDATE login_requests SET email=?,google_sub=?,confirmed=1 WHERE id=? AND confirmed=0')
        .run(identity.email,identity.google_sub??null,flow.request_id).changes===1;
    }),
    deny:db.transaction((raw:unknown)=>{
      const flow=find(raw);if(!flow)return false;
      db.query('DELETE FROM device_codes WHERE request_id=?').run(flow.request_id);
      db.query('DELETE FROM login_requests WHERE id=?').run(flow.request_id);
      return true;
    }),
  };
}

/** What an installation may call itself on the confirmation page: printable, short, never markup. */
export function deviceLabel(raw:unknown):string {
  const label=typeof raw==='string'?raw.replace(/[\p{C}<>]/gu,'').trim().slice(0,80):'';
  return label||'Qoopia installation';
}

/** Fixed-window attempt counter on the broker's login_limits table. */
export function attemptCounter(db:Database) {
  return db.transaction((key:string,limit:number,windowMs:number)=>{
    const bucket=hash('device:'+key+':'+Math.floor(Date.now()/windowMs));
    const row=db.query('SELECT count FROM login_limits WHERE key=?').get(bucket) as {count:number}|null;
    if(row&&row.count>=limit)return false;
    db.query('INSERT INTO login_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(bucket,Date.now()+windowMs);
    return true;
  });
}
