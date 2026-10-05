import type { Database } from 'bun:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { privateDirectory, safePath, readJson, durableWrite, hash, randomToken } from '../utils/fs.ts';
import { consumeLocalLogin } from '../delivery/local-login.ts';
import { localOwner } from '../delivery/owner-onboarding.ts';
import { isHttps, localOwnerLoginHandler } from '../dashboard-api.ts';
import { getClientIp } from '../http/respond.ts';
import { loginEmail, type LoginIdentity } from './broker.ts';
import { MAX_BODY_BYTES, readBoundedText } from '../utils/http-json.ts';
import { parseCookies } from '../utils/cookies.ts';

export const LOGIN_ORIGIN = 'https://auth.qoopia.ai';
type Binding = LoginIdentity & {ownerId:string};
const claimCookie = 'qoopia_owner_setup';
const pendingCookie = 'qoopia_login_request';

/** This file belongs to the installation, not a replaceable application generation. */
export function ownerIdentity(root:string): Binding | null {
  const file=safePath(path.join(root,'config/owner-identity.json'));
  if(!fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);
  if(stat.uid!==process.getuid?.() || (stat.mode&0o077) || stat.size>2048)throw new Error('Unsafe owner identity file');
  const binding=readJson<Binding>(file);
  if(!binding||typeof binding.ownerId!=='string'||!binding.ownerId||loginEmail(binding.email)!==binding.email||
    (binding.googleSub!==undefined&&(typeof binding.googleSub!=='string'||!binding.googleSub||binding.googleSub.length>255)))throw new Error('Invalid owner identity');
  return binding;
}

/** The confirmation page shows this so the owner can tell their own installation from someone else's. */
export function installationLabel(){return 'Qoopia '+(process.platform==='darwin'?'Mac':'Linux')+' · '+os.hostname().slice(0,48);}
/** A broker that predates device codes answers a device request as an invalid sign-in request. */
export const DEVICE_CODE_UNSUPPORTED='The Qoopia sign-in service does not offer code sign-in yet. Sign in with email or Google from a browser on this network, or try again after the service is updated.';
/** Only a code-shaped value and a verification page on the sign-in origin are ever shown to the owner. */
export function deviceCodeStep(data:Record<string,unknown>,origin=LOGIN_ORIGIN){
  const code=data.user_code,uri=data.verification_uri,complete=data.verification_uri_complete;
  if(typeof code!=='string'||!/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(code)||uri!==origin+'/device'||complete!==origin+'/device?code='+code)
    throw new Error(DEVICE_CODE_UNSUPPORTED);
  return {userCode:code,verificationUri:uri,verificationUriComplete:complete,expiresIn:600};
}
export function localIdentityLogin(root:string,database:Database,request:typeof fetch=fetch) {
  const claims=new Map<string,{ownerId:string;expires:number}>();
  const attempts=new Map<string,{ownerId:string;version:number;id:string;verifier:string;expires:number;busy:boolean;ip:string}>();
  const cookie=(req:IncomingMessage,name=claimCookie)=>parseCookies(req.headers.cookie)[name]??'';
  const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  const broker=async(route:string,body:unknown)=>{
    const response=await request(LOGIN_ORIGIN+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20_000)});
    const data=JSON.parse(await readBoundedText(response,MAX_BODY_BYTES)) as Record<string,unknown>;
    if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Sign-in is temporarily unavailable');
    return data;
  };
  return async(req:IncomingMessage,res:ServerResponse,route:string,body:Record<string,unknown>={})=>{
    const now=Date.now();
    for(const [key,claim] of claims)if(claim.expires<=now)claims.delete(key);
    for(const [key,attempt] of attempts)if(attempt.expires<=now)attempts.delete(key);
    try{
      if(route===''&&req.method==='GET'){
        const attempt=attempts.get(cookie(req,pendingCookie));
        return json(res,200,{enabled:true,linked:!!ownerIdentity(root),pending:!!attempt});
      }
      if(route==='/setup'){
        if(process.env.QOOPIA_STANDALONE!=='true')throw new Error('Server owner identity must be provisioned by the operator');
        if(typeof body.code!=='string')throw new Error('Open Qoopia from its launcher to finish setup');
        const ownerId=consumeLocalLogin(body.code);
        if(!ownerId)throw new Error('Setup link expired. Open Qoopia again');
        localOwner(database,ownerId);
        const existing=ownerIdentity(root);
        if(existing){if(existing.ownerId!==ownerId)throw new Error('This installation is linked to another owner');return json(res,200,{linked:true});}
        const token=randomToken();claims.set(hash(token),{ownerId,expires:now+600_000});
        res.setHeader('set-cookie',`${claimCookie}=${token}; HttpOnly; SameSite=Strict; Path=/api/dashboard/identity; Max-Age=600${isHttps(req)?'; Secure':''}`);
        return json(res,200,{linked:false,setup:true});
      }
      if(route==='/start'){
        if(!['google','email','account','device'].includes(String(body.method)))throw new Error('Choose Google or email');
        const binding=ownerIdentity(root),claim=claims.get(hash(cookie(req)));
        if(!binding&&!claim)throw new Error('Open Qoopia from its launcher once to link this workspace');
        // /poll would refuse any other address anyway; refusing here spends no e-mail on it.
        if(body.method==='email'&&binding&&loginEmail(body.email)!==binding.email)throw new Error('Use the email or Google account already linked to this workspace');
        if(body.method==='account'&&(!binding||!isHttps(req)))throw new Error('Sign in with email to connect this workspace');
        const owner=localOwner(database,binding?.ownerId??claim!.ownerId),verifier=randomToken();
        // F-125: e-mail and Google sign-ins finish only from the network of this browser, which the broker
        // cannot see behind this server (account continuation has its own one-use code).
        // A device code is confirmed on another device signed in to the account: its possession is the binding.
        const bind=body.method==='email'||body.method==='google',device=body.method==='device';
        let data:Record<string,unknown>;
        try{data=await broker('/requests',{method:body.method,language:body.language==='ru'?'ru':'en',...(body.method==='email'?{email:loginEmail(body.email)}:{}),...(body.method==='account'?{dashboard:'https://'+req.headers.host+'/dashboard'}:{}),...(bind?{bind:'network',starter_ip:getClientIp(req)}:{}),...(device?{label:installationLabel()}:{}),challenge:hash(verifier)});}
        catch(error){throw device&&error instanceof Error&&error.message==='Invalid sign-in request'?new Error(DEVICE_CODE_UNSUPPORTED):error;}
        if(typeof data.id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.id))throw new Error('Invalid sign-in service response');
        const step=device?deviceCodeStep(data):undefined;
        // A client keeps its two newest pending sign-ins and the table its 20 newest, so anonymous
        // starts can never refuse the owner's. ponytail: the broker's per-server hourly start
        // allowance is still shared by every caller; closing that needs a per-installation allowance.
        const ip=getClientIp(req),own=[...attempts].filter(([,attempt])=>attempt.ip===ip);
        if(own.length>=2)attempts.delete(own[0]![0]);
        if(attempts.size>=20)attempts.delete(attempts.keys().next().value!);
        const token=randomToken();attempts.set(token,{ownerId:owner.agent_id,version:owner.session_version!,id:data.id,verifier,expires:now+600_000,busy:false,ip});
        res.setHeader('set-cookie',`${pendingCookie}=${token}; HttpOnly; SameSite=Strict; Path=/api/dashboard/identity; Max-Age=600${isHttps(req)?'; Secure':''}`);
        return json(res,200,step??(body.method==='account'?{accountUrl:LOGIN_ORIGIN+'/profile?app=ios&request='+data.id}:body.method==='google'?{googleUrl:LOGIN_ORIGIN+'/google?request='+data.id}:{email:loginEmail(body.email)}));
      }
      if(route==='/poll'){
        const token=cookie(req,pendingCookie),attempt=attempts.get(token);
        if(!attempt)throw new Error('Sign-in expired. Please start again');
        if(attempt.busy)return json(res,200,{pending:true});
        attempt.busy=true;
        try{
          const identity=await broker('/redeem',{id:attempt.id,verifier:attempt.verifier,...(body.accountCode?{account_code:body.accountCode}:{})});
          if(identity.pending===true)return json(res,200,{pending:true});
          attempts.delete(token);
          const email=loginEmail(identity.email),sub=identity.googleSub;
          if(sub!==undefined&&(typeof sub!=='string'||!sub||sub.length>255))throw new Error('Invalid Google identity');
          const owner=localOwner(database,attempt.ownerId),binding=ownerIdentity(root);
          if(owner.session_version!==attempt.version)throw new Error('Sign-in was cancelled. Please start again');
          if(binding&&(binding.ownerId!==owner.agent_id || (binding.email!==email&&(!sub||binding.googleSub!==sub))))throw new Error('Use the email or Google account already linked to this workspace');
          const linked:Binding={ownerId:owner.agent_id,email,...(sub?{googleSub:sub}:binding?.googleSub?{googleSub:binding.googleSub}:{})};
          privateDirectory(path.join(root,'config'));
          durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify(linked));
          claims.delete(hash(cookie(req)));
          return localOwnerLoginHandler(req,res,owner.agent_id);
        }finally{attempt.busy=false;}
      }
      return json(res,404,{error:'Not found'});
    }catch(error){return json(res,400,{error:error instanceof Error?error.message:'Sign-in failed'});}
  };
}
