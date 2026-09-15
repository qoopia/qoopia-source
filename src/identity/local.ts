import type { Database } from 'bun:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { privateDirectory, safePath, readJson, durableWrite } from '../utils/fs.ts';
import { consumeLocalLogin } from '../delivery/local-login.ts';
import { localOwner } from '../delivery/owner-onboarding.ts';
import { isHttps, localOwnerLoginHandler } from '../dashboard-api.ts';
import { loginEmail, type LoginIdentity } from './broker.ts';

export const LOGIN_ORIGIN = 'https://auth.qoopia.ai';
type Binding = LoginIdentity & {ownerId:string};
const random = () => randomBytes(32).toString('base64url');
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
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

export function localIdentityLogin(root:string,database:Database,request:typeof fetch=fetch) {
  const claims=new Map<string,{ownerId:string;expires:number}>();
  const attempts=new Map<string,{ownerId:string;version:number;id:string;verifier:string;expires:number;busy:boolean}>();
  const cookie=(req:IncomingMessage,name=claimCookie)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)??'';
  const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  const broker=async(route:string,body:unknown)=>{
    const response=await request(LOGIN_ORIGIN+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20_000)});
    const data=await response.json() as Record<string,unknown>;
    if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Sign-in is temporarily unavailable');
    return data;
  };
  return async(req:IncomingMessage,res:ServerResponse,route:string,body:Record<string,unknown>={})=>{
    const now=Date.now();
    for(const [key,claim] of claims)if(claim.expires<=now)claims.delete(key);
    for(const [key,attempt] of attempts)if(attempt.expires<=now)attempts.delete(key);
    try{
      if(route===''&&req.method==='GET')return json(res,200,{enabled:true,linked:!!ownerIdentity(root),pending:attempts.has(cookie(req,pendingCookie))});
      if(route==='/setup'){
        if(process.env.QOOPIA_STANDALONE!=='true')throw new Error('Server owner identity must be provisioned by the operator');
        if(typeof body.code!=='string')throw new Error('Open Qoopia from its launcher to finish setup');
        const ownerId=consumeLocalLogin(body.code);
        if(!ownerId)throw new Error('Setup link expired. Open Qoopia again');
        localOwner(database,ownerId);
        const existing=ownerIdentity(root);
        if(existing){if(existing.ownerId!==ownerId)throw new Error('This installation is linked to another owner');return json(res,200,{linked:true});}
        const token=random();claims.set(hash(token),{ownerId,expires:now+600_000});
        res.setHeader('set-cookie',`${claimCookie}=${token}; HttpOnly; SameSite=Strict; Path=/api/dashboard/identity; Max-Age=600${isHttps(req)?'; Secure':''}`);
        return json(res,200,{linked:false,setup:true});
      }
      if(route==='/start'){
        if(body.method!=='google'&&body.method!=='email')throw new Error('Choose Google or email');
        if(attempts.size>=20)throw new Error('Too many pending sign-ins. Please wait a few minutes');
        const binding=ownerIdentity(root),claim=claims.get(hash(cookie(req)));
        if(!binding&&!claim)throw new Error('Open Qoopia from its launcher once to link this workspace');
        const owner=localOwner(database,binding?.ownerId??claim!.ownerId),verifier=random();
        const data=await broker('/requests',{method:body.method,language:body.language==='ru'?'ru':'en',...(body.method==='email'?{email:loginEmail(body.email)}:{}),challenge:hash(verifier)});
        if(typeof data.id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.id))throw new Error('Invalid sign-in service response');
        const token=random();attempts.set(token,{ownerId:owner.agent_id,version:owner.session_version!,id:data.id,verifier,expires:now+600_000,busy:false});
        res.setHeader('set-cookie',`${pendingCookie}=${token}; HttpOnly; SameSite=Strict; Path=/api/dashboard/identity; Max-Age=600${isHttps(req)?'; Secure':''}`);
        return json(res,200,{...(body.method==='google'?{googleUrl:LOGIN_ORIGIN+'/google?request='+data.id}:{email:loginEmail(body.email)})});
      }
      if(route==='/poll'){
        const token=cookie(req,pendingCookie),attempt=attempts.get(token);
        if(!attempt)throw new Error('Sign-in expired. Please start again');
        if(attempt.busy)return json(res,200,{pending:true});
        attempt.busy=true;
        try{
          const identity=await broker('/redeem',{id:attempt.id,verifier:attempt.verifier});
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
