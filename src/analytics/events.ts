import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

// Closed vocabulary: never accept request bodies, URLs, identity or error text.
const eventSchema=z.object({
 id:z.string().uuid(),
 kind:z.enum(['site_view','download_click','download_redirect','site_performance','auth_request','mail_accepted','mail_failed','email_confirmed','login_redeemed','profile_login','profile_logout','profile_saved','profile_deleted','auth_http']),
 page:z.enum(['home','docs','releases','mobile','404','profile','confirm','google','requests','redeem','devices','other']).optional(),
 language:z.enum(['en','ru','other']).optional(),
 platform:z.enum(['mac','linux','other']).optional(),
 // Public release version of the offered installer (not a client identifier).
 version:z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,40})?$/).optional(),
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
  if(event.page&&!['home','docs','releases','mobile','404'].includes(event.page))return new Response(null,{status:400,headers});
  if(event.version&&event.kind!=='download_click')return new Response(null,{status:400,headers});
  write(event);return new Response(null,{status:204,headers});
 }catch{return new Response(null,{status:400,headers});}
}

// Installer downloads counted on the server, on the redirect: qoopia.ai/download/<platform> (Pages
// _redirects) → auth.qoopia.ai/download/<platform> → 302 to the current GitHub asset named by the public
// release.json. Works without JavaScript and past blockers; stores no IP, cookie or identifier.
const ASSET=/^https:\/\/github\.com\/qoopia\/qoopia-downloads\/releases\/download\/v[0-9A-Za-z.-]+\/[0-9A-Za-z._-]+$/;
const releaseSchema=z.object({version:eventSchema.shape.version.unwrap(),availability:z.literal('public'),
 packages:z.object({mac:z.object({url:z.string().regex(ASSET)}),linux:z.object({url:z.string().regex(ASSET)})})});
export const DOWNLOAD_PLATFORMS=['mac','linux'] as const;
export const LATEST_RELEASES='https://github.com/qoopia/qoopia-downloads/releases/latest';
// Crawlers follow links too; a count is a person or their agent (curl/wget included), not an indexer.
const CRAWLER=/bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|preview|headless/i;
export function downloadRedirect(loadRelease:()=>Promise<unknown>,count:(event:{platform:'mac'|'linux';version?:string;referrer:'direct'|'internal'|'other'},ip:string)=>void,now=Date.now,ttl=300_000){
 let cached:{at:number;release:z.infer<typeof releaseSchema>}|null=null;
 const current=async()=>{
  if(cached&&now()-cached.at<ttl)return cached.release;
  try{cached={at:now(),release:releaseSchema.parse(await loadRelease())};}catch{/* Keep the last good release; without one, send people to the release page. */}
  return cached?.release??null;
 };
 return async(req:Request,platform:string,ip:string):Promise<Response>=>{
  const headers={'cache-control':'no-store','referrer-policy':'no-referrer'};
  if(!(DOWNLOAD_PLATFORMS as readonly string[]).includes(platform))return new Response('Unknown platform',{status:404,headers});
  if(req.method!=='GET'&&req.method!=='HEAD')return new Response(null,{status:405,headers:{...headers,allow:'GET, HEAD'}});
  const release=await current(),location=release?.packages[platform as 'mac'|'linux'].url??LATEST_RELEASES;
  const referer=req.headers.get('referer');let referrer:'direct'|'internal'|'other'='direct';
  try{if(referer)referrer=/(^|\.)qoopia\.ai$/.test(new URL(referer).hostname)?'internal':'other';}catch{referrer='other';}
  const privacy=req.headers.get('sec-gpc')==='1'||req.headers.get('dnt')==='1';
  if(req.method==='GET'&&!privacy&&!CRAWLER.test(req.headers.get('user-agent')??''))
   try{count({platform:platform as 'mac'|'linux',...(release?{version:release.version}:{}),referrer},ip);}catch{/* Counting never blocks a download. */}
  return new Response(null,{status:302,headers:{...headers,location}});
 };
}
