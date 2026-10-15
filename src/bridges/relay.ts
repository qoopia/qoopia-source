import type {Database} from 'bun:sqlite';
import {z} from 'zod';
import {BRIDGE_RELAY,MAX_PACKET,MAX_RPC,fingerprint,id,invitationCode,label,peerId,publicIdentity,sha,verifyRPC} from './protocol.ts';
// The public invite page runs exactly this script and nothing else: its hash is the whole script-src.
// Its words come from data attributes, so one script (one hash) serves every language. Only a
// well-formed code is ever shown or copied: whatever else the fragment holds stays out of the clipboard.
const INVITE_SCRIPT=`const raw=location.hash.slice(1),d=document.body.dataset,code=/^QPB1\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$/.test(raw)?raw:'';document.querySelector('#invite').value=code||d.invalid;document.querySelector('#copy').onclick=async()=>{if(!code)return;try{await navigator.clipboard.writeText(code);document.querySelector('#status').textContent=d.copied}catch{document.querySelector('#invite').select()}};`;
const INVITE_SCRIPT_HASH='sha256-'+new Bun.CryptoHasher('sha256').update(INVITE_SCRIPT).digest('base64');
// A4-09: the page in Graphite Focus 2.0.1 (DESIGN.md account roles) and in English or Russian. The wordmark is the
// approved src/public/brand/graphite/qoopia-wordmark-ivory.svg, inlined because the relay serves no files.
export const INVITE_WORDMARK='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 255 72" role="img" aria-label="qoopia"><g fill="none" stroke="#F2EFE9" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="22" cy="30" r="17"/><path d="M39 13v49"/><circle cx="66" cy="30" r="17"/><circle cx="110" cy="30" r="17"/><circle cx="154" cy="30" r="17"/><path d="M137 14v48M187 15v33"/><circle cx="221" cy="30" r="17"/><path d="M238 13v34"/></g><circle cx="187" cy="3" r="2.5" fill="#F2EFE9"/></svg>';
const INVITE_TEXT={
  en:{title:'Join a Qoopia bridge',heading:'An invitation to a Qoopia bridge',body:'Open your Qoopia, go to Bridges → Accept an invitation and paste this code. Joining shares only the catalogue titles and descriptions each member chooses to publish. Files stay private until their owner approves a request.',label:'Invitation code',copy:'Copy invitation',copied:'Copied. Paste it into your Qoopia.',invalid:'This invitation link is incomplete. Ask for a new one.'},
  ru:{title:'Приглашение в мост Qoopia',heading:'Приглашение в мост Qoopia',body:'Откройте свою Qoopia, перейдите в «Мосты» → «Принять приглашение» и вставьте этот код. Участники видят только названия и описания, которые каждый сам публикует в каталоге. Файлы остаются закрытыми, пока владелец не одобрит запрос.',label:'Код приглашения',copy:'Скопировать приглашение',copied:'Скопировано. Вставьте код в свою Qoopia.',invalid:'Ссылка приглашения неполная. Попросите новую.'},
};
export function invitePage(req:Request){
  const asked=new URL(req.url).searchParams.get('lang'),lang=asked==='ru'||asked==='en'?asked:/^ru\b/i.test(req.headers.get('accept-language')??'')?'ru':'en',t=INVITE_TEXT[lang];
  const attr=(s:string)=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${t.title}</title>`+
    `<style>body{background:#111110;color:#f2efe9;font:400 15px/1.5 Manrope,system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 20px}.q-wordmark{display:block;width:105px;height:auto;margin-bottom:32px}h1{font-size:32px;font-weight:500;line-height:1.2;letter-spacing:-.025em;margin:0 0 16px}p{color:#c3bdb4;margin:0 0 24px}label{display:block;font-size:14px;margin-bottom:8px}textarea{box-sizing:border-box;width:100%;min-height:120px;background:#191918;color:#f2efe9;border:1px solid #8a847b;border-radius:7px;padding:12px;font:16px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}button{margin-top:16px;min-height:44px;padding:8px 18px;background:#f2efe9;color:#111110;border:0;border-radius:6px;font:500 14px/1.5 Manrope,system-ui,sans-serif;cursor:pointer}button:hover{background:#c3bdb4}:focus-visible{outline:3px solid #f2efe9;outline-offset:4px}#status{margin-top:12px;min-height:1.5em}</style>`+
    `<body data-copied="${attr(t.copied)}" data-invalid="${attr(t.invalid)}"><span class="q-wordmark">${INVITE_WORDMARK}</span><h1>${t.heading}</h1><p>${t.body}</p><label for="invite">${t.label}</label><textarea id="invite" readonly></textarea><button id="copy" type="button">${t.copy}</button><p id="status" role="status"></p><script>${INVITE_SCRIPT}</script></body></html>`;
}

const DAY=86400_000;
type Member={peer:string;label:string;identity:string;state:string;admission:string|null};
type Group={id:string;owner:string;label:string;identity:string;creation:string;epoch:number};
type Routed={id:string;group:string;from:string;to:string;data:string;expires:number};
export function bridgeRelay(db:Database,relay=BRIDGE_RELAY) {
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_relay_groups(id TEXT PRIMARY KEY,owner TEXT NOT NULL,label TEXT NOT NULL,identity TEXT NOT NULL,creation TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 1,closed_at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS bridge_relay_members(group_id TEXT NOT NULL,peer TEXT NOT NULL,label TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL,admission TEXT,PRIMARY KEY(group_id,peer));
    CREATE TABLE IF NOT EXISTS bridge_relay_invites(digest TEXT PRIMARY KEY,group_id TEXT NOT NULL,expires INTEGER NOT NULL,statement TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS bridge_relay_nonces(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_relay_limits(id TEXT PRIMARY KEY,n INTEGER NOT NULL,expires INTEGER NOT NULL);`);
  // ponytail: bounded, volatile relay buffers. A sender retains its durable
  // outbox until end-to-end acknowledgement; add durable relay storage only
  // if users need delivery without any simultaneous online window.
  const queue=new Map<string,Routed>();let bytes=0;
  const remove=(key:string)=>{const value=queue.get(key);if(value){bytes-=value.data.length;queue.delete(key);}};
  const count=(sql:string,...args:string[])=>(db.query(sql).get(...args) as {n:number}).n;
  const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY'};
  const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
  function group(value:unknown) {
    const g=db.query('SELECT * FROM bridge_relay_groups WHERE id=?').get(id.parse(value)) as Group|null;
    if(!g)throw new Error('Bridge unavailable');return g;
  }
  function member(g:Group,peer:string,owner=false) {
    const m=db.query('SELECT * FROM bridge_relay_members WHERE group_id=? AND peer=? AND state=?').get(g.id,peer,'active') as Member|null;
    if(!m||(owner&&g.owner!==peer))throw new Error('Bridge access denied');return m;
  }
  function limit(key:string,max:number,window=60_000) {
    const bucket=sha(key+':'+Math.floor(Date.now()/window));
    const allowed=db.transaction(()=>{
      const row=db.query('SELECT n FROM bridge_relay_limits WHERE id=?').get(bucket) as {n:number}|null;
      if(row&&row.n>=max)return false;
      db.query('INSERT INTO bridge_relay_limits VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET n=n+1').run(bucket,Date.now()+window);return true;
    })();
    if(!allowed)throw new Error('Bridge rate limit reached; try later');
  }
  function roster(g:Group,peer:string) {
    const self=db.query('SELECT state FROM bridge_relay_members WHERE group_id=? AND peer=?').get(g.id,peer) as {state:string}|null;
    if(self?.state!=='active')return {id:g.id,state:self?.state??'removed'};
    const members=db.query("SELECT peer,label,identity,state,admission FROM bridge_relay_members WHERE group_id=? AND (state='active' OR ?=?) ORDER BY peer")
      .all(g.id,peer,g.owner) as Member[];
    return {id:g.id,state:'active',name:g.label,owner:g.owner,identity:JSON.parse(g.identity),creation:g.creation,epoch:g.epoch,
      members:members.map(m=>({...m,identity:JSON.parse(m.identity)}))};
  }
  function cleanup() {
    const now=Date.now();
    db.query('DELETE FROM bridge_relay_nonces WHERE expires<?').run(now-5000);
    db.query('DELETE FROM bridge_relay_limits WHERE expires<?').run(now);
    db.query('DELETE FROM bridge_relay_invites WHERE expires<?').run(now-DAY);
    for(const closed of db.query('SELECT id FROM bridge_relay_groups WHERE closed_at_ms<?').all(now-30*DAY) as {id:string}[])db.transaction(()=>{
      db.query('DELETE FROM bridge_relay_invites WHERE group_id=?').run(closed.id);
      db.query('DELETE FROM bridge_relay_members WHERE group_id=?').run(closed.id);
      db.query('DELETE FROM bridge_relay_groups WHERE id=?').run(closed.id);
    })();
    for(const [key,message] of queue)if(message.expires<=now)remove(key);
  }
  const handler=async (req:Request,clientIp='unknown'):Promise<Response>=>{
    try {
      const url=new URL(req.url),base=new URL(relay);
      if(url.pathname===base.pathname+'/invite'&&req.method==='GET')return new Response(invitePage(req),{headers:{...headers,'content-type':'text/html; charset=utf-8',vary:'accept-language','content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src '${INVITE_SCRIPT_HASH}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`}});
      if(url.pathname!==base.pathname+'/rpc'||req.method!=='POST')return json({error:'Not found'},404);
      if(req.headers.get('origin'))return json({error:'Use your own Qoopia installation'},403);
      limit('ip:'+clientIp,240);
      if(req.headers.get('content-type')?.split(';')[0]!=='application/json')return json({error:'JSON required'},400);
      const text=await req.text();if(Buffer.byteLength(text)>MAX_RPC)return json({error:'Request too large'},413);
      const raw=JSON.parse(text),rpc=await verifyRPC(raw,relay),{op,body,peer,identity}=rpc;
      const now=Date.now();
      cleanup();
      if(!db.query('INSERT OR IGNORE INTO bridge_relay_nonces VALUES (?,?)').run(peer+':'+rpc.nonce,rpc.expires).changes)
        return json({error:'Replayed request'},409);
      limit('peer:'+peer,180);
      if(op==='create') {
        const a=z.object({id,name:label,member_name:label.optional()}).strict().parse(body);
        const old=db.query('SELECT * FROM bridge_relay_groups WHERE id=?').get(a.id) as Group|null;
        if(old){member(old,peer,true);if(old.label!==a.name)throw new Error('Creation retry changed');return json(roster(old,peer));}
        limit('create:'+clientIp,8,DAY);
        if(count('SELECT count(*) n FROM bridge_relay_groups')>=512||count('SELECT count(*) n FROM bridge_relay_groups WHERE owner=?',peer)>=8)
          throw new Error('Pilot bridge capacity reached');
        db.transaction(()=>{
          db.query('INSERT INTO bridge_relay_groups(id,owner,label,identity,creation) VALUES (?,?,?,?,?)').run(a.id,peer,a.name,JSON.stringify(identity),raw.signature);
          db.query('INSERT INTO bridge_relay_members VALUES (?,?,?,?,?,?)').run(a.id,peer,a.member_name??a.name,JSON.stringify(identity),'active',raw.signature);
        })();return json(roster(group(a.id),peer));
      }
      if(op==='join') {
        const a=z.object({code:z.string().max(200),name:label}).strict().parse(body),code=invitationCode(a.code,relay);
        const invite=db.query('SELECT * FROM bridge_relay_invites WHERE digest=? AND expires>? AND revoked=0').get(sha(code.secret),now) as {group_id:string;statement:string}|null;
        if(!invite)throw new Error('Invitation expired or revoked');
        const g=group(invite.group_id);if(g.owner!==code.owner)throw new Error('Invitation owner mismatch');
        const old=db.query('SELECT state FROM bridge_relay_members WHERE group_id=? AND peer=?').get(g.id,peer) as {state:string}|null;
        if(old?.state==='removed')throw new Error('This installation was removed; ask for a new membership decision');
        if(!old) {
          limit('join:'+clientIp,24,DAY);
          if(count('SELECT count(*) n FROM bridge_relay_members WHERE group_id=?',g.id)>=32)throw new Error('Pilot bridge limit: 32 installations');
          db.query('INSERT INTO bridge_relay_members VALUES (?,?,?,?,?,NULL)').run(g.id,peer,a.name,JSON.stringify(identity),'pending');
        }
        return json({id:g.id,name:g.label,owner:g.owner,identity:JSON.parse(g.identity),invitation:invite.statement,creation:g.creation,state:old?.state??'pending'});
      }
      if(op==='state'&&!db.query('SELECT id FROM bridge_relay_groups WHERE id=?').get(id.parse(body.group)))return json({id:body.group,state:'removed'});
      const g=group(body.group);
      if(op==='state') {
        z.object({group:id}).strict().parse(body);
        return json(roster(g,peer));
      }
      if(op==='leave'&&(db.query('SELECT state FROM bridge_relay_members WHERE group_id=? AND peer=?').get(g.id,peer) as {state:string}|null)?.state==='pending') {
        // A join the owner never admitted is withdrawn, not removed: a later invitation may ask again.
        z.object({group:id}).strict().parse(body);
        db.query("DELETE FROM bridge_relay_members WHERE group_id=? AND peer=? AND state='pending'").run(g.id,peer);
        return json({removed:peer});
      }
      member(g,peer);
      if(op==='invite') {
        member(g,peer,true);
        const a=z.object({group:id,digest:fingerprint,expires:z.number().int()}).strict().parse(body);
        if(a.expires<=now||a.expires>now+7*DAY)throw new Error('Invitation expiry must be within seven days');
        limit('invite:'+g.id,50,DAY);
        const old=db.query('SELECT group_id,expires,revoked FROM bridge_relay_invites WHERE digest=?').get(a.digest) as {group_id:string;expires:number;revoked:number}|null;
        if(old&&(old.group_id!==g.id||old.expires!==a.expires||old.revoked))throw new Error('Invitation retry changed or was revoked');
        db.query('INSERT OR IGNORE INTO bridge_relay_invites VALUES (?,?,?,?,0)').run(a.digest,g.id,a.expires,raw.signature);return json({expires:a.expires});
      }
      if(op==='revoke-invite') {
        member(g,peer,true);const a=z.object({group:id,digest:fingerprint}).strict().parse(body);
        db.query('UPDATE bridge_relay_invites SET revoked=1 WHERE group_id=? AND digest=?').run(g.id,a.digest);return json({revoked:true});
      }
      if(op==='admit') {
        member(g,peer,true);const a=z.object({group:id,peer:fingerprint,identity:publicIdentity}).strict().parse(body);
        if(peerId(a.identity)!==a.peer)throw new Error('Joining identity mismatch');
        const pending=db.query('SELECT * FROM bridge_relay_members WHERE group_id=? AND peer=?').get(g.id,a.peer) as Member|null;
        if(!pending||pending.identity!==JSON.stringify(a.identity))throw new Error('Joining installation changed');
        if(a.peer===g.owner||pending.state==='active')return json(roster(g,peer));
        db.transaction(()=>{
          db.query("UPDATE bridge_relay_members SET state='active',admission=? WHERE group_id=? AND peer=?").run(raw.signature,g.id,a.peer);
          db.query('UPDATE bridge_relay_groups SET epoch=epoch+1 WHERE id=?').run(g.id);
        })();return json(roster(group(g.id),peer));
      }
      if(op==='remove'||op==='leave') {
        const a=z.object({group:id,peer:fingerprint.optional()}).strict().parse(body),target=op==='leave'?peer:a.peer;
        if(!target)throw new Error('Select a member');if(op==='remove')member(g,peer,true);
        if(target===g.owner)throw new Error('The creator closes the group instead of leaving');
        db.transaction(()=>{
          db.query("UPDATE bridge_relay_members SET state='removed' WHERE group_id=? AND peer=?").run(g.id,target);
          db.query('UPDATE bridge_relay_groups SET epoch=epoch+1 WHERE id=?').run(g.id);
        })();
        for(const [key,p] of queue)if(p.group===g.id&&(p.from===target||p.to===target))remove(key);
        return json({removed:target});
      }
      if(op==='close') {
        z.object({group:id}).strict().parse(body);member(g,peer,true);
        db.transaction(()=>{db.query("UPDATE bridge_relay_members SET state='removed' WHERE group_id=?").run(g.id);db.query('UPDATE bridge_relay_invites SET revoked=1 WHERE group_id=?').run(g.id);db.query('UPDATE bridge_relay_groups SET epoch=epoch+1,closed_at_ms=? WHERE id=?').run(now,g.id);})();
        for(const [key,p] of queue)if(p.group===g.id)remove(key);return json({closed:true});
      }
      if(op==='send') {
        const a=z.object({group:id,id,to:fingerprint,data:z.string().min(1).max(MAX_PACKET)}).strict().parse(body);member(g,a.to);
        if(a.to===peer)throw new Error('Select another member');limit('send:'+peer,60);
        const key=g.id+':'+peer+':'+a.id,old=queue.get(key);
        if(old){if(old.to!==a.to||old.data!==a.data)throw new Error('Delivery retry changed');return json({buffered:true});}
        if(bytes+a.data.length>64*1024*1024||[...queue.values()].filter(p=>p.to===a.to).length>=64)return json({error:'Recipient buffer is full; keep the local outbox'},429);
        queue.set(key,{...a,from:peer,expires:now+120_000});bytes+=a.data.length;return json({buffered:true});
      }
      if(op==='poll') {
        const a=z.object({group:id,ack:z.array(z.object({id,from:fingerprint}).strict()).max(16).default([])}).strict().parse(body);
        for(const ack of a.ack){const key=g.id+':'+ack.from+':'+ack.id;if(queue.get(key)?.to===peer)remove(key);}
        const messages=[];let size=0;
        for(const p of queue.values())if(p.group===g.id&&p.to===peer) {
          member(g,p.from);if(size+p.data.length>MAX_PACKET||messages.length>=8)break;
          messages.push({id:p.id,from:p.from,to:p.to,group:p.group,data:p.data});size+=p.data.length;
        }
        return json({messages,epoch:g.epoch});
      }
      return json({error:'Unknown bridge operation'},404);
    } catch {return json({error:'Bridge request refused. Check membership, invitation and request limits.'},403);}
  };
  return Object.assign(handler,{cleanup});
}
