import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

// Closed vocabulary: never accept request bodies, URLs, identity or error text.
export const eventSchema=z.object({
 id:z.string().uuid(),
 kind:z.enum(['site_view','download_click','site_performance','auth_request','mail_accepted','mail_failed','email_confirmed','login_redeemed','profile_login','profile_logout','profile_saved','auth_http']),
 page:z.enum(['home','docs','releases','404','profile','confirm','google','requests','redeem','devices','other']).optional(),
 language:z.enum(['en','ru','other']).optional(),
 platform:z.enum(['mac','linux','other']).optional(),
 method:z.enum(['email','google','other']).optional(),
 outcome:z.enum(['ok','pending','rejected','error']).optional(),
 viewport:z.enum(['small','medium','large']).optional(),
 referrer:z.enum(['direct','search','social','internal','other']).optional(),
 duration_ms:z.number().int().min(0).max(300_000).optional(),
 value:z.number().int().min(0).max(300_000).optional(),
 measurement:z.enum(['dom_ready','load','lcp']).optional(),
}).strict();
export type AnalyticsEvent=z.infer<typeof eventSchema>;
export type RecordEvent=(event:Omit<AnalyticsEvent,'id'>)=>void;
export const noAnalytics:RecordEvent=()=>{};

export function eventStore(db:Database,now=Date.now,dailyLimit=100_000) {
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250;
 CREATE TABLE IF NOT EXISTS analytics_events(id TEXT PRIMARY KEY,received_at INTEGER NOT NULL,source TEXT NOT NULL CHECK(source IN ('server','browser')),kind TEXT NOT NULL,data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS analytics_events_time ON analytics_events(received_at);
 CREATE TABLE IF NOT EXISTS analytics_daily(day TEXT PRIMARY KEY,accepted INTEGER NOT NULL DEFAULT 0,dropped INTEGER NOT NULL DEFAULT 0);`);
 const insert=db.query('INSERT OR IGNORE INTO analytics_events VALUES (?,?,?,?,?)');
 return {
  write(raw:unknown,source:'server'|'browser'='server') {
   const event=eventSchema.parse(raw);
   const {id,kind,...data}=event;
   return db.transaction(()=>{
    if(db.query('SELECT 1 FROM analytics_events WHERE id=?').get(id))return false;
    const at=now(),day=new Date(at).toISOString().slice(0,10);
    db.query('INSERT OR IGNORE INTO analytics_daily(day) VALUES (?)').run(day);
    const count=(db.query('SELECT accepted FROM analytics_daily WHERE day=?').get(day) as {accepted:number}).accepted;
    if(count>=dailyLimit){db.query('UPDATE analytics_daily SET dropped=dropped+1 WHERE day=?').run(day);return false;}
    const added=insert.run(id,at,source,kind,JSON.stringify(data)).changes>0;
    if(added)db.query('UPDATE analytics_daily SET accepted=accepted+1 WHERE day=?').run(day);
    return added;
   })();
  },
 };
}

export function persistentAnalytics(file:string|undefined) {
 if(!file)return undefined;
 const db=new Database(file,{create:true});
 const store=eventStore(db);
 let failed=0;
 const record:RecordEvent=event=>{try{store.write({...event,id:randomUUID()});}catch{failed++;}};
 return {record,store,db,failures:()=>failed};
}

// Cross-origin collection is limited to the public website. No cookies or
// persistent visitor ID. Browser-originated observations are never trusted as
// server-confirmed installs, logins, downloads or client calls.
export async function browserEvent(req:Request,write:(raw:unknown)=>boolean):Promise<Response> {
 const allowed=['https://qoopia.ai','https://www.qoopia.ai'];
 const origin=req.headers.get('origin');
 if(!origin||!allowed.includes(origin))return new Response(null,{status:403});
 const headers={'access-control-allow-origin':origin,'vary':'Origin','cache-control':'no-store','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'};
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return new Response(null,{status:405,headers});
 if(req.headers.get('sec-gpc')==='1'||req.headers.get('dnt')==='1')return new Response(null,{status:204,headers});
 const type=req.headers.get('content-type')?.split(';')[0];
 if(!['application/json','text/plain'].includes(type??''))return new Response(null,{status:415,headers});
 // Enforce the size while reading, including when Content-Length is absent.
 const reader=req.body?.getReader();if(!reader)return new Response(null,{status:400,headers});
 let size=0;const chunks:Uint8Array[]=[];
 try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();return new Response(null,{status:413,headers});}chunks.push(value);}}
 catch{return new Response(null,{status:400,headers});}
 try {
  const event=eventSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
  if(!['site_view','download_click','site_performance'].includes(event.kind))return new Response(null,{status:400,headers});
  if(event.page&&!['home','docs','releases','404'].includes(event.page))return new Response(null,{status:400,headers});
  write(event);return new Response(null,{status:204,headers});
 }catch{return new Response(null,{status:400,headers});}
}
