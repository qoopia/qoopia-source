import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fingerprint, id, label, publicIdentity, secret, sha, verifyRPC} from '../bridges/protocol.ts';
import {accounts} from './account.ts';

export interface TunnelProvider {
  ensure(deviceId:string, hostname:string, tunnelSecret:string):Promise<{id:string;account:string}>;
  remove(deviceId:string, hostname:string, tunnelId:string|null):Promise<void>;
}
export interface DeviceRegistryOptions {domain:string;provider:TunnelProvider;maxDevices?:number;maxPerAccount?:number}
type Device={id:string;account_id:string;peer:string;installation_id:string;workspace_id:string;label:string;hostname:string;
  state:'provisioning'|'active'|'revoked';tunnel_id:string|null;tunnel_account:string|null;secret_hash:string;created_at:number;revoked_at:number|null};
const enrollment=z.object({grant:fingerprint,installation_id:id,workspace_id:z.string().min(1).max(128),label,
  tunnel_secret:z.string().regex(/^[A-Za-z0-9+/]{43}=$/)}).strict();
const publicDevice=(d:Device)=>({id:d.id,installation_id:d.installation_id,workspace_id:d.workspace_id,label:d.label,
  public_origin:'https://'+d.hostname,state:d.state,created_at:d.created_at,revoked_at:d.revoked_at});
class DeviceError extends Error {constructor(readonly code:string,readonly status=400){super(code);}}

/** Account and route metadata only. Neither memory nor private installation keys are stored here. */
export function deviceRegistry(db:Database,origin:string,options:DeviceRegistryOptions) {
  if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(options.domain))throw new Error('Invalid managed domain');
  const audience=new URL('/devices',origin).href,max=options.maxDevices??100,perAccount=options.maxPerAccount??5;
  if(!Number.isInteger(max)||max<1||max>900||!Number.isInteger(perAccount)||perAccount<1||perAccount>20)throw new Error('Invalid device limits');
  db.exec(`CREATE TABLE IF NOT EXISTS connection_accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,google_sub TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS connection_device_grants(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,peer TEXT NOT NULL,expires INTEGER NOT NULL,device_id TEXT);
    CREATE TABLE IF NOT EXISTS connection_devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,peer TEXT NOT NULL UNIQUE,identity TEXT NOT NULL,
      installation_id TEXT NOT NULL,workspace_id TEXT NOT NULL,label TEXT NOT NULL,hostname TEXT NOT NULL UNIQUE,state TEXT NOT NULL,
      tunnel_id TEXT,tunnel_account TEXT,secret_hash TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER,cleanup_done INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,installation_id));
    CREATE TABLE IF NOT EXISTS connection_device_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
  const busy=new Set<string>();
  const identify=accounts(db);
  const cleanup=()=>{
    db.query('DELETE FROM connection_device_grants WHERE expires<=?').run(Date.now());
    db.query('DELETE FROM connection_device_nonces WHERE expires<=?').run(Date.now());
  };
  // Only loginBroker calls this after an email-confirmed, PKCE-bound sign-in.
  const issueGrant=db.transaction((identity:{email:string;googleSub?:string},peer:string)=>{
    fingerprint.parse(peer);cleanup();
    const accountId=identify(identity);
    const grant=secret();db.query('INSERT INTO connection_device_grants VALUES (?,?,?,?,NULL)').run(sha(grant),accountId,peer,Date.now()+600_000);
    return grant;
  });
  const get=(deviceId:string)=>db.query('SELECT * FROM connection_devices WHERE id=?').get(deviceId) as Device|null;
  const claim=db.transaction((peer:string,identity:unknown,input:z.infer<typeof enrollment>)=>{
    const grant=db.query('SELECT * FROM connection_device_grants WHERE hash=? AND peer=? AND expires>?')
      .get(sha(input.grant),peer,Date.now()) as {account_id:string;device_id:string|null}|null;
    if(!grant)throw new DeviceError('SIGN_IN_REQUIRED',401);
    const prior=db.query('SELECT * FROM connection_devices WHERE peer=? OR (account_id=? AND installation_id=?)')
      .get(peer,grant.account_id,input.installation_id) as Device|null;
    if(prior){
      if(prior.peer!==peer||prior.account_id!==grant.account_id||prior.installation_id!==input.installation_id||prior.workspace_id!==input.workspace_id||prior.secret_hash!==sha(input.tunnel_secret))
        throw new DeviceError('DEVICE_IDENTITY_CONFLICT',409);
      if(prior.state==='revoked')throw new DeviceError('DEVICE_REVOKED',410);
      if(grant.device_id&&grant.device_id!==prior.id)throw new DeviceError('GRANT_ALREADY_USED',409);
      db.query('UPDATE connection_device_grants SET device_id=? WHERE hash=?').run(prior.id,sha(input.grant));return prior;
    }
    if(grant.device_id)throw new DeviceError('GRANT_ALREADY_USED',409);
    // Revocation ends access immediately, but a provider route still occupies
    // capacity until cleanup succeeds. Failed removals must not bypass headroom.
    const occupied=(db.query("SELECT count(*) AS n FROM connection_devices WHERE state!='revoked' OR cleanup_done=0").get() as {n:number}).n;
    const accountActive=(db.query("SELECT count(*) AS n FROM connection_devices WHERE state!='revoked' AND account_id=?").get(grant.account_id) as {n:number}).n;
    if(occupied>=max||accountActive>=perAccount)throw new DeviceError('DEVICE_LIMIT_REACHED',429);
    const deviceId=randomUUID(),hostname='c-'+deviceId+'.'+options.domain;
    db.query(`INSERT INTO connection_devices(id,account_id,peer,identity,installation_id,workspace_id,label,hostname,state,secret_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,'provisioning',?,?)`).run(deviceId,grant.account_id,peer,JSON.stringify(publicIdentity.parse(identity)),input.installation_id,input.workspace_id,input.label,hostname,sha(input.tunnel_secret),Date.now());
    db.query('UPDATE connection_device_grants SET device_id=? WHERE hash=?').run(deviceId,sha(input.grant));return get(deviceId)!;
  });
  const handler=async(req:Request):Promise<Response>=>{
    const json=(status:number,value:unknown)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
    try{
      if(req.method!=='POST'||new URL(req.url).href!==audience)return json(404,{code:'NOT_FOUND'});
      if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(origin).origin)throw new DeviceError('ORIGIN_REFUSED',403);
      if(req.headers.get('content-type')?.split(';')[0]!=='application/json')throw new DeviceError('JSON_REQUIRED');
      const text=await req.text();if(text.length>16_384)throw new DeviceError('BODY_TOO_LARGE',413);
      let rpc:Awaited<ReturnType<typeof verifyRPC>>;
      try{rpc=await verifyRPC(JSON.parse(text),audience);}catch{throw new DeviceError('DEVICE_PROOF_INVALID',401);}
      cleanup();
      try{db.query('INSERT INTO connection_device_nonces VALUES (?,?)').run(rpc.nonce,rpc.expires+5000);}
      catch{throw new DeviceError('REPLAY_REFUSED',409);}
      if(rpc.op==='enroll'){
        const input=enrollment.parse(rpc.body),device=claim(rpc.peer,rpc.identity,input);
        if(busy.has(device.id))return json(202,{code:'PROVISIONING',device:publicDevice(device)});
        busy.add(device.id);
        try{
          // Reconcile interrupted provisioning by the same device id. Never allocate a second route on retry.
          const tunnel=await options.provider.ensure(device.id,device.hostname,input.tunnel_secret);
          if(get(device.id)?.state==='revoked'){
            db.query('UPDATE connection_devices SET cleanup_done=0 WHERE id=?').run(device.id);
            await options.provider.remove(device.id,device.hostname,tunnel.id);
            db.query('UPDATE connection_devices SET cleanup_done=1 WHERE id=?').run(device.id);
            throw new DeviceError('DEVICE_REVOKED',410);
          }
          db.query("UPDATE connection_devices SET state='active',tunnel_id=?,tunnel_account=? WHERE id=? AND state!='revoked'")
            .run(id.parse(tunnel.id),z.string().regex(/^[a-f0-9]{32}$/).parse(tunnel.account),device.id);
          return json(200,{device:publicDevice(get(device.id)!),tunnel:{id:tunnel.id,account:tunnel.account},lease_seconds:120});
        }finally{busy.delete(device.id);}
      }
      const caller=db.query('SELECT * FROM connection_devices WHERE peer=?').get(rpc.peer) as Device|null;
      if(!caller||caller.state!=='active'&&!(caller.state==='revoked'&&rpc.op==='revoke'&&rpc.body.device_id===caller.id))
        throw new DeviceError(caller?.state==='revoked'?'DEVICE_REVOKED':'DEVICE_NOT_ACTIVE',403);
      if(rpc.op==='status'){
        z.object({}).strict().parse(rpc.body);return json(200,{device:publicDevice(caller),lease_seconds:120});
      }
      if(rpc.op==='list'){
        z.object({}).strict().parse(rpc.body);
        return json(200,{devices:(db.query('SELECT * FROM connection_devices WHERE account_id=? ORDER BY created_at,id').all(caller.account_id) as Device[]).map(publicDevice)});
      }
      if(rpc.op==='revoke'){
        const input=z.object({device_id:id}).strict().parse(rpc.body),target=get(input.device_id);
        if(!target||target.account_id!==caller.account_id)throw new DeviceError('DEVICE_NOT_FOUND',404);
        db.query("UPDATE connection_devices SET state='revoked',revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(Date.now(),target.id);
        db.query('DELETE FROM connection_device_grants WHERE device_id=?').run(target.id);
        // Revocation is durable before provider cleanup; no new lease can be issued after this point.
        // Let an in-flight ensure finish before deletion. Otherwise it can recreate
        // the route after an early cleanup and incorrectly release its capacity.
        if(busy.has(target.id))return json(202,{code:'REVOKED_CLEANUP_PENDING',device:publicDevice(get(target.id)!)});
        try{await options.provider.remove(target.id,target.hostname,target.tunnel_id);db.query('UPDATE connection_devices SET cleanup_done=1 WHERE id=?').run(target.id);}
        catch{return json(202,{code:'REVOKED_CLEANUP_PENDING',device:publicDevice(get(target.id)!)});}
        return json(200,{code:'DEVICE_REVOKED',device:publicDevice(get(target.id)!)});
      }
      throw new DeviceError('UNKNOWN_OPERATION');
    }catch(error){return error instanceof DeviceError?json(error.status,{code:error.code}):
      json(error instanceof z.ZodError||error instanceof SyntaxError?400:503,{code:error instanceof z.ZodError||error instanceof SyntaxError?'INVALID_REQUEST':'DEVICE_SERVICE_UNAVAILABLE'});}
  };
  const reconcileRevocations=async()=>{
    for(const d of db.query("SELECT * FROM connection_devices WHERE state='revoked' AND cleanup_done=0 ORDER BY revoked_at LIMIT 5").all() as Device[]){
      if(busy.has(d.id))continue;busy.add(d.id);
      try{await options.provider.remove(d.id,d.hostname,d.tunnel_id);db.query('UPDATE connection_devices SET cleanup_done=1 WHERE id=?').run(d.id);}
      catch{/* Revoked rows stay queued. No provider text or request material is logged. */}
      finally{busy.delete(d.id);}
    }
  };
  return {issueGrant,handler,cleanup,reconcileRevocations};
}
