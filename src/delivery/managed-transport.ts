import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type {Database} from 'bun:sqlite';
import {z} from 'zod';
import {newIdentity,peerId,secret,signRPC} from '../bridges/protocol.ts';
import {LOGIN_ORIGIN,ownerIdentity} from '../identity/local.ts';
import {localOwner} from './owner-onboarding.ts';
import {authorize} from '../auth/policy.ts';
import {env} from '../utils/env.ts';
import {QoopiaError} from '../utils/errors.ts';
import {readTransport,writeTransport,type TransportConfig} from './transport-config.ts';
import {transportSupervisor} from './transport-supervisor.ts';

export const networkActionSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('network-plan')}).strict(),z.object({action:z.literal('network-status')}).strict(),
  z.object({action:z.literal('network-start'),method:z.enum(['email','google']),language:z.enum(['en','ru']).optional()}).strict(),
  z.object({action:z.literal('network-resume')}).strict(),z.object({action:z.literal('network-enable')}).strict(),
  z.object({action:z.literal('network-disable')}).strict(),z.object({action:z.literal('network-devices')}).strict(),
  z.object({action:z.literal('network-revoke'),device_id:z.string().uuid()}).strict(),
]);
let installed:ReturnType<typeof managedTransport>|undefined;
export function enableManagedTransport(root:string,database:Database,bundle:string) {
  installed=managedTransport(root,database,path.join(bundle,'assets/native/cloudflared'));
  void installed.refresh();process.once('exit',()=>installed?.stop());return installed;
}
export function managedNetworkAction(ownerId:string,input:unknown) {
  if(!installed)return {format:'qoopia-connections/1',state:'unsupported',code:'MANAGED_INSTALLATION_REQUIRED',
    next_action:'Use the installed Qoopia service on the machine holding this workspace.'};
  return installed.action(ownerId,input);
}

/** The wizard and UID-authenticated CLI use this same resumable, owner-scoped workflow. */
export function managedTransport(root:string,database:Database,binary:string,request:typeof fetch=fetch,loginOrigin=LOGIN_ORIGIN) {
  let busy=false;
  const result=(state:string,code:string,extra:Record<string,unknown>={})=>({format:'qoopia-connections/1',state,code,...extra});
  const post=async(route:string,body:unknown)=>{
    const response=await request(loginOrigin+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
      redirect:'error',signal:AbortSignal.timeout(25_000)});
    const text=await response.text();if(text.length>65_536)throw new Error('Invalid device service response');
    const data=JSON.parse(text) as Record<string,unknown>;
    if(!response.ok){
      if(data.code==='DEVICE_REVOKED')throw new QoopiaError('DEVICE_REVOKED','This device was revoked');
      if(data.code==='DEVICE_LIMIT_REACHED')throw new QoopiaError('DEVICE_LIMIT_REACHED','The account or pilot device limit was reached');
      if(data.code==='SIGN_IN_REQUIRED'||response.status===410)throw new QoopiaError('SIGN_IN_REQUIRED','Sign in again to continue registration');
      throw new Error('Device service unavailable');
    }
    return data;
  };
  const rpc=(c:TransportConfig,op:string,body:Record<string,unknown>)=>signRPC(c.identity,loginOrigin+'/devices',op,body).then(envelope=>post('/devices',envelope));
  const verifyDevice=(c:TransportConfig,data:Record<string,unknown>)=>{
    const next={...c,device:data.device,tunnel:data.tunnel??c.tunnel} as TransportConfig;
    // Roundtrip through the strict protected-file reader also checks installation/workspace/HTTPS binding.
    const device=data.device as TransportConfig['device'];
    if(!device||device.installation_id!==c.installation_id||device.workspace_id!==c.workspace_id||
      device.public_origin!=='https://c-'+device.id+'.'+new URL(loginOrigin).hostname.split('.').slice(1).join('.'))
      throw new Error('Device service identity mismatch');
    return next;
  };
  const supervisor=transportSupervisor({root,upstreamPort:env.PORT,binary,config:()=>readTransport(root),request,lease:async()=>{
    const c=readTransport(root);if(!c?.device)return 'revoked';
    try{
      const data=await rpc(c,'status',{}),next=verifyDevice(c,data);
      if(next.device?.state!=='active')return 'revoked';return 'active';
    }catch(e){
      if(e instanceof QoopiaError&&e.code==='DEVICE_REVOKED'){
        writeTransport(root,{...c,enabled:false,device:{...c.device,state:'revoked'}});return 'revoked';
      }throw e;
    }
  }});
  const status=()=>{
    const c=readTransport(root),health=supervisor.status();
    if(c&&!c.device&&(c.flow&&c.flow.expires<=Date.now()||c.grant&&c.grant_expires!==undefined&&c.grant_expires<=Date.now()))
      return result('requires_user_action','SIGN_IN_REQUIRED',{transport:health,device:null,enabled:false,account_login_pending:false,
        next_action:'The account confirmation expired. Start sign-in again; the saved installation identity and local memory are preserved.'});
    return result(c?.device?.state==='revoked'?'error':!c?.device?'requires_user_action':c.enabled?health.reachable?'ready':'temporarily_unavailable':'requires_user_action',
      c?.device?.state==='revoked'?'DEVICE_REVOKED':!c?.device?c?.flow?'ACCOUNT_CONFIRMATION_REQUIRED':'NETWORK_SETUP_REQUIRED':c.enabled?health.reachable?'NETWORK_ONLINE':'NETWORK_CONNECTING':'NETWORK_DISABLED',
      {transport:health,device:c?.device??null,enabled:c?.enabled??false,account_login_pending:!!c?.flow,
        next_action:!c?.device?'Confirm the installation account, then resume setup.':!c.enabled?'Enable external access when needed.':'The installation reconnects automatically while awake and online.'});
  };
  const action=async(ownerId:string,raw:unknown)=>{
    const input=networkActionSchema.parse(raw),owner=localOwner(database,ownerId);authorize(database,owner,'owner');
    let c=readTransport(root);
    if(c&&(c.owner_id!==ownerId||c.workspace_id!==owner.workspace_id))throw new QoopiaError('FORBIDDEN','Transport belongs to another workspace');
    if(input.action==='network-plan')return result('requires_user_action','NETWORK_CONSENT_REQUIRED',{workspace_id:owner.workspace_id,
      provider:'Cloudflare Tunnel',outbound_only:true,local_memory:true,public_dashboard:false,provider_account_required:false,
      transit:'Cloudflare terminates HTTPS and processes authorized MCP traffic and connection metadata. This path is not end-to-end encrypted.',
      next_action:'Confirm external access and sign in to the Qoopia account linked to this installation.'});
    if(input.action==='network-status')return status();
    if(busy)return result('temporarily_unavailable','ACTION_IN_PROGRESS',{next_action:'Check status, then resume.'});
    busy=true;
    try{
      if(input.action==='network-start'){
        const binding=ownerIdentity(root);
        if(!binding||binding.ownerId!==ownerId)return result('requires_user_action','OWNER_ACCOUNT_REQUIRED',{next_action:'Finish the Qoopia account sign-in in this installation first.'});
        if(c?.device?.state==='revoked')return result('error','DEVICE_REVOKED',{next_action:'Register a new installation identity through recovery; the old identity remains revoked.'});
        c??={format:'qoopia-transport/1',owner_id:ownerId,workspace_id:owner.workspace_id,installation_id:randomUUID(),identity:await newIdentity(),tunnel_secret:randomBytes(32).toString('base64'),enabled:false};
        // Save the installation key before contacting any provider, so a lost response cannot change its identity.
        writeTransport(root,c);
        const verifier=secret(),data=await post('/requests',{method:input.method,language:input.language,...(input.method==='email'?{email:binding.email}:{}),
          challenge:createHash('sha256').update(verifier).digest('hex'),device_peer:peerId(c.identity)});
        const id=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(data.id);
        c.flow={id,verifier,expires:Date.now()+600_000};delete c.grant;delete c.grant_expires;writeTransport(root,c);
        return result('requires_user_action','ACCOUNT_CONFIRMATION_REQUIRED',{...(input.method==='google'?{open_url:loginOrigin+'/google?request='+id}:{email:binding.email}),
          next_action:'Complete the account confirmation, then resume this setup.'});
      }
      if(!c)return result('requires_user_action','NETWORK_SETUP_REQUIRED');
      if(input.action==='network-disable'){c.enabled=false;writeTransport(root,c);supervisor.pause();return status();}
      if(input.action==='network-devices')return result('ready','ACCOUNT_DEVICES',await rpc(c,'list',{}));
      if(input.action==='network-revoke'){
        // Own-device shutdown is immediate, even if provider cleanup has to be retried.
        if(c.device?.id===input.device_id){c.enabled=false;writeTransport(root,c);supervisor.pause();}
        const revoked=await rpc(c,'revoke',{device_id:input.device_id});
        if(c.device?.id===input.device_id){c.device={...c.device,state:'revoked'};delete c.grant;delete c.grant_expires;delete c.flow;writeTransport(root,c);}
        return result('ready',revoked.code==='REVOKED_CLEANUP_PENDING'?'REVOKED_CLEANUP_PENDING':'DEVICE_REVOKED',{device_id:input.device_id,memory_preserved:true});
      }
      if(input.action==='network-resume'){
        if(c.flow&&c.flow.expires<=Date.now()||c.grant&&c.grant_expires!==undefined&&c.grant_expires<=Date.now())
          return result('requires_user_action','SIGN_IN_REQUIRED',{next_action:'The account confirmation expired. Start sign-in again with the same installation.'});
        if(c.flow){
          const data=await post('/redeem',{id:c.flow.id,verifier:c.flow.verifier});
          if(data.pending===true)return result('requires_user_action','ACCOUNT_CONFIRMATION_REQUIRED');
          const binding=ownerIdentity(root);
          if(!binding||binding.ownerId!==ownerId||data.email!==binding.email&&(!binding.googleSub||data.googleSub!==binding.googleSub))
            throw new QoopiaError('FORBIDDEN','Use the Qoopia account already linked to this installation');
          c.grant=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(data.device_grant);c.grant_expires=Date.now()+600_000;delete c.flow;writeTransport(root,c);
        }
        if(c.grant){
          const data=await rpc(c,'enroll',{grant:c.grant,installation_id:c.installation_id,workspace_id:c.workspace_id,label:'Qoopia '+(process.platform==='darwin'?'Mac':'Linux'),tunnel_secret:c.tunnel_secret});
          if(data.code==='PROVISIONING')return result('temporarily_unavailable','NETWORK_PROVISIONING',{
            expires_at:c.grant_expires??null,next_action:'Resume this registration before confirmation expires. If it expires, sign in again; the same device is reconciled.'});
          c=verifyDevice(c,data);c.enabled=true;delete c.grant;delete c.grant_expires;writeTransport(root,c);c=readTransport(root)!;
        }
      }
      if(!c.device||!c.tunnel)return result('requires_user_action','ACCOUNT_CONFIRMATION_REQUIRED');
      if(c.device.state==='revoked')return result('error','DEVICE_REVOKED');
      if(input.action==='network-enable'){c.enabled=true;writeTransport(root,c);}
      env.PUBLIC_URL=c.device.public_origin;
      await supervisor.refresh();return status();
    }catch(e){
      if(e instanceof QoopiaError&&e.code==='SIGN_IN_REQUIRED'){
        if(c?.flow)c.flow.expires=0;if(c?.grant)c.grant_expires=0;if(c)writeTransport(root,c);
        return result('requires_user_action','SIGN_IN_REQUIRED',{next_action:'Start account sign-in again. The saved installation identity and local memory are preserved.'});
      }
      if(e instanceof QoopiaError)throw e;
      return result('temporarily_unavailable','NETWORK_SERVICE_UNAVAILABLE',{next_action:'Keep this setup and resume later. Local memory remains available.'});
    }finally{busy=false;}
  };
  const existing=readTransport(root);if(existing?.device)env.PUBLIC_URL=existing.device.public_origin;
  return {action,status,refresh:supervisor.refresh,stop:supervisor.stop};
}
