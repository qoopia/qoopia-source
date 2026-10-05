import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type {Database} from 'bun:sqlite';
import {z} from 'zod';
import {newIdentity,peerId,secret,signRPC} from '../bridges/protocol.ts';
import {DEVICE_CODE_UNSUPPORTED,LOGIN_ORIGIN,deviceCodeStep,installationLabel,ownerIdentity} from '../identity/local.ts';
import {localOwner} from './owner-onboarding.ts';
import {authorize} from '../auth/policy.ts';
import {env} from '../utils/env.ts';
import {QoopiaError} from '../utils/errors.ts';
import {readTransport,writeTransport,type TransportConfig} from './transport-config.ts';
import {durableWrite,privateDirectory} from '../utils/fs.ts';
import {loginEmail} from '../identity/broker.ts';
import {transportSupervisor} from './transport-supervisor.ts';

const networkActionSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('network-plan')}).strict(),z.object({action:z.literal('network-status')}).strict(),
  z.object({action:z.literal('network-start'),method:z.enum(['email','google','device']),language:z.enum(['en','ru']).optional()}).strict(),
  z.object({action:z.literal('network-resume')}).strict(),z.object({action:z.literal('network-enable')}).strict(),
  z.object({action:z.literal('network-disable')}).strict(),z.object({action:z.literal('network-devices')}).strict(),
  z.object({action:z.literal('network-revoke'),device_id:z.string().uuid()}).strict(),
]);
let installed:ReturnType<typeof managedTransport>|undefined;
const deviceNext=(code:string,uri:string)=>'On your phone or another computer, open '+uri+', sign in to the Qoopia account linked to this installation and enter the code '+code+'. Then resume this setup (network-resume).';
const REVOKED_NEXT='This device was revoked. Start external access again (network-start) to register this installation as a new device; memory and local connections stay, remote applications must be connected again at the new address.';
/** The tunnel origin replaces the loopback origin for discovery. An installation never sets QOOPIA_OAUTH_ISSUER,
 * so the issuer env.ts derived from the loopback PUBLIC_URL at startup moves with it: otherwise the generic
 * metadata sent remote clients to http://127.0.0.1 as their authorization server. */
function publishOrigin(origin:string){env.PUBLIC_URL=origin;env.OAUTH_ISSUER=origin;}
/** Only a live, enabled device is advertised. Paused, revoked or unfinished, the installation is loopback again:
 * discovery stops naming an origin nobody answers and new remote connections are refused as NOT_READY. */
function syncOrigin(c:TransportConfig|null){publishOrigin(c?.enabled&&c.device&&c.device.state!=='revoked'?c.device.public_origin:`http://127.0.0.1:${env.PORT}`);}
export function enableManagedTransport(root:string,database:Database,bundle:string) {
  installed=managedTransport(root,database,path.join(bundle,'assets/native/cloudflared'));
  void installed.refresh();process.once('exit',()=>installed?.stop());return installed;
}
export function submitManagedNetworkAction(ownerId:string,input:unknown) {
  return installed?installed.submit(ownerId,input):managedNetworkAction(ownerId,input);
}
export function managedNetworkAction(ownerId:string,input:unknown) {
  if(!installed)return {format:'qoopia-connections/1',state:'unsupported',code:'MANAGED_INSTALLATION_REQUIRED',
    next_action:'Use the installed Qoopia service on the machine holding this workspace.'};
  return installed.action(ownerId,input);
}

/** The wizard and UID-authenticated CLI use this same resumable, owner-scoped workflow. */
export function managedTransport(root:string,database:Database,binary:string,request:typeof fetch=fetch,loginOrigin=LOGIN_ORIGIN) {
  let busy=false;
  let operation: {state:'running'|'completed'|'failed';result?:Record<string,unknown>}|undefined;
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
      // The account service's hourly allowances (emails per address, starts per network) refuse with this text.
      if(typeof data.error==='string'&&data.error.startsWith('Too many sign-in'))throw new QoopiaError('RATE_LIMITED','Too many sign-in emails');
      throw Object.assign(new Error('Device service unavailable'),{status:response.status});
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
        const revoked={...c,enabled:false,device:{...c.device,state:'revoked' as const}};writeTransport(root,revoked);syncOrigin(revoked);return 'revoked';
      }throw e;
    }
  }});
  const status=()=>{
    const c=readTransport(root),health=supervisor.status();
    if(c&&!c.device&&(c.flow&&c.flow.expires<=Date.now()||c.grant&&c.grant_expires!==undefined&&c.grant_expires<=Date.now()))
      return result('requires_user_action','SIGN_IN_REQUIRED',{transport:health,device:null,enabled:false,account_login_pending:false,
        next_action:'The account confirmation expired. Start sign-in again; the saved installation identity and local memory are preserved.'});
    const code=!c?.device&&c?.flow?.user_code?{user_code:c.flow.user_code,verification_uri:c.flow.verification_uri,expires_at:c.flow.expires}:{};
    return result(c?.device?.state==='revoked'?'error':!c?.device?'requires_user_action':c.enabled?health.reachable?'ready':'temporarily_unavailable':'requires_user_action',
      c?.device?.state==='revoked'?'DEVICE_REVOKED':!c?.device?c?.flow?'ACCOUNT_CONFIRMATION_REQUIRED':'NETWORK_SETUP_REQUIRED':c.enabled?health.reachable?'NETWORK_ONLINE':'NETWORK_CONNECTING':'NETWORK_DISABLED',
      {operation,transport:health,device:c?.device??null,enabled:c?.enabled??false,account_login_pending:!!c?.flow,...code,
        next_action:c?.device?.state==='revoked'?REVOKED_NEXT:!c?.device?(code.user_code?deviceNext(code.user_code,code.verification_uri!):'Confirm the installation account, then resume setup.'):!c.enabled?'Enable external access when needed.':'The installation reconnects automatically while awake and online.'});
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
        // A device code is approved by the account holder on another device, so it also links an installation that has
        // no account yet: `qoopia owner-login` on a headless server gives a local owner but nothing there can link one.
        if(binding?binding.ownerId!==ownerId:input.method!=='device')return result('requires_user_action','OWNER_ACCOUNT_REQUIRED',
          {next_action:'Finish the Qoopia account sign-in in this installation first, or start with {"method":"device"}: the account that approves the code is linked.'});
        // Recovery after a revoke: a new installation identity and key are registered as a new device after this
        // fresh sign-in. The revoked key stays revoked; memory and local connections are untouched.
        if(c?.device?.state==='revoked')c=null;
        c??={format:'qoopia-transport/1',owner_id:ownerId,workspace_id:owner.workspace_id,installation_id:randomUUID(),identity:await newIdentity(),tunnel_secret:randomBytes(32).toString('base64'),enabled:false};
        // Save the installation key before contacting any provider, so a lost response cannot change its identity.
        writeTransport(root,c);
        // Email/Google are bound to this installation's network: the browser on this computer finishes them.
        // A headless server uses a device code instead, confirmed on any device signed in to the account.
        const verifier=secret(),device=input.method==='device';let data:Record<string,unknown>;
        try{data=await post('/requests',{method:input.method,language:input.language,...(device?{label:installationLabel()}:{bind:'network'}),...(input.method==='email'?{email:binding!.email}:{}),
          challenge:createHash('sha256').update(verifier).digest('hex'),device_peer:peerId(c.identity)});}
        catch(error){
          if(device&&(error as {status?:number}).status===400)return result('error','DEVICE_CODE_UNSUPPORTED',{next_action:DEVICE_CODE_UNSUPPORTED});
          throw error;
        }
        const id=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(data.id);
        let step:ReturnType<typeof deviceCodeStep>|undefined;
        if(device)try{step=deviceCodeStep(data,loginOrigin);}catch{return result('error','DEVICE_CODE_UNSUPPORTED',{next_action:DEVICE_CODE_UNSUPPORTED});}
        c.flow={id,verifier,expires:Date.now()+600_000,...(step?{user_code:step.userCode,verification_uri:step.verificationUri}:{})};delete c.grant;delete c.grant_expires;writeTransport(root,c);
        if(step)return result('requires_user_action','ACCOUNT_CONFIRMATION_REQUIRED',{user_code:step.userCode,verification_uri:step.verificationUri,
          open_url:step.verificationUriComplete,expires_at:c.flow.expires,next_action:deviceNext(step.userCode,step.verificationUri)});
        return result('requires_user_action','ACCOUNT_CONFIRMATION_REQUIRED',{...(input.method==='google'?{open_url:loginOrigin+'/google?request='+id}:{email:binding!.email}),
          next_action:'Complete the account confirmation, then resume this setup.'});
      }
      if(!c)return result('requires_user_action','NETWORK_SETUP_REQUIRED');
      if(input.action==='network-disable'){c.enabled=false;writeTransport(root,c);syncOrigin(c);supervisor.pause();return status();}
      if(input.action==='network-devices')return result('ready','ACCOUNT_DEVICES',await rpc(c,'list',{}));
      if(input.action==='network-revoke'){
        // Own-device shutdown is immediate, even if provider cleanup has to be retried.
        if(c.device?.id===input.device_id){c.enabled=false;writeTransport(root,c);syncOrigin(c);supervisor.pause();}
        const revoked=await rpc(c,'revoke',{device_id:input.device_id});
        if(c.device?.id===input.device_id){c.device={...c.device,state:'revoked'};delete c.grant;delete c.grant_expires;delete c.flow;writeTransport(root,c);}
        return result('ready',revoked.code==='REVOKED_CLEANUP_PENDING'?'REVOKED_CLEANUP_PENDING':'DEVICE_REVOKED',{device_id:input.device_id,memory_preserved:true});
      }
      if(input.action==='network-resume'){
        if(c.flow&&c.flow.expires<=Date.now()||c.grant&&c.grant_expires!==undefined&&c.grant_expires<=Date.now())
          return result('requires_user_action','SIGN_IN_REQUIRED',{next_action:'The account confirmation expired. Start sign-in again with the same installation.'});
        if(c.flow){
          const data=await post('/redeem',{id:c.flow.id,verifier:c.flow.verifier});
          if(data.pending===true)return result('requires_user_action','ACCOUNT_CONFIRMATION_REQUIRED',c.flow.user_code?{user_code:c.flow.user_code,
            verification_uri:c.flow.verification_uri,expires_at:c.flow.expires,next_action:deviceNext(c.flow.user_code,c.flow.verification_uri!)}:{});
          const binding=ownerIdentity(root);
          if(binding?binding.ownerId!==ownerId||data.email!==binding.email&&(!binding.googleSub||data.googleSub!==binding.googleSub):!c.flow.user_code)
            throw new QoopiaError('FORBIDDEN','Use the Qoopia account already linked to this installation');
          if(!binding){
            const sub=data.googleSub;if(sub!==undefined&&(typeof sub!=='string'||!sub||sub.length>255))throw new Error('Invalid account identity');
            privateDirectory(path.join(root,'config'));
            durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId,email:loginEmail(data.email),...(sub?{googleSub:sub}:{})}));
          }
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
      if(c.device.state==='revoked')return result('error','DEVICE_REVOKED',{next_action:REVOKED_NEXT});
      if(input.action==='network-enable'){c.enabled=true;writeTransport(root,c);}
      syncOrigin(c);
      await supervisor.refresh();return status();
    }catch(e){
      if(e instanceof QoopiaError&&e.code==='SIGN_IN_REQUIRED'){
        if(c?.flow)c.flow.expires=0;if(c?.grant)c.grant_expires=0;if(c)writeTransport(root,c);
        return result('requires_user_action','SIGN_IN_REQUIRED',{next_action:'Start account sign-in again. The saved installation identity and local memory are preserved.'});
      }
      if(e instanceof QoopiaError&&e.code==='RATE_LIMITED')return result('requires_user_action','TOO_MANY_SIGN_INS',
        {next_action:'Too many sign-in emails were sent in the last hour. Confirm with Google instead, or try again later. Local memory remains available.'});
      if(e instanceof QoopiaError)throw e;
      return result('temporarily_unavailable','NETWORK_SERVICE_UNAVAILABLE',{next_action:'Keep this setup and resume later. Local memory remains available.'});
    }finally{busy=false;}
  };
  const submit=(ownerId:string,raw:unknown)=>{
    const input=networkActionSchema.parse(raw),owner=localOwner(database,ownerId);authorize(database,owner,'owner');
    const config=readTransport(root);if(config&&(config.owner_id!==ownerId||config.workspace_id!==owner.workspace_id))throw new QoopiaError('FORBIDDEN','Transport belongs to another workspace');
    if(['network-plan','network-status','network-devices'].includes(input.action))return action(ownerId,input);
    if(operation?.state==='running'||busy)throw new QoopiaError('CONFLICT','A connection action is running');
    const current:{state:'running'|'completed'|'failed';result?:Record<string,unknown>}={state:'running'};operation=current;
    void action(ownerId,input).then(value=>{current.result={...value};delete current.result.operation;current.state='completed';},()=>{
      current.state='failed';current.result=result('temporarily_unavailable','NETWORK_SERVICE_UNAVAILABLE',{next_action:'Keep this setup and try again. Local memory remains available.'});
    });
    return {accepted:true,code:'ACTION_IN_PROGRESS'};
  };
  syncOrigin(readTransport(root));
  return {action,submit,status,refresh:supervisor.refresh,stop:supervisor.stop};
}
