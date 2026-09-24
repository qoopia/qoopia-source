import type {IncomingMessage,ServerResponse} from 'node:http';
import {db} from '../db/connection.ts';
import {authFromSessionCookie,DASHBOARD_COOKIE,parseCookies,verifySession} from '../dashboard-session.ts';
import {localOwner} from '../delivery/owner-onboarding.ts';
import {ownerIdentity} from '../identity/local.ts';
import {env} from '../utils/env.ts';
import {isReadOnlyInstance} from '../utils/instance-role.ts';
import {json} from './respond.ts';

/** The signed dashboard cookie must belong to the explicitly configured human service owner. */
export function serviceOwnerEmail(req:IncomingMessage):string|null{
  const expected=process.env.QOOPIA_SERVICE_OWNER_AGENT_ID;
  const secret=process.env.QOOPIA_OWNER_BRIDGE_SECRET;
  if(!expected||!secret||Buffer.byteLength(secret)<32||isReadOnlyInstance()||req.headers.authorization)return null;
  const session=verifySession(parseCookies(req.headers.cookie)[DASHBOARD_COOKIE]??'');
  if(session?.exp!==null||!session.owner)return null;
  const auth=authFromSessionCookie(req);
  if(!auth||auth.type!=='owner'||auth.agent_id!==expected)return null;
  try{
    localOwner(db,auth.agent_id);
    const root=process.env.QOOPIA_STANDALONE==='true'?JSON.parse(process.env.QOOPIA_STANDALONE_LAYOUT!).root:env.ROOT_DIR;
    const binding=ownerIdentity(root);
    return binding?.ownerId===auth.agent_id?binding.email:null;
  }catch{return null;}
}

export async function handleServiceOwner(req:IncomingMessage,res:ServerResponse,request:typeof fetch=fetch){
  res.setHeader('cache-control','no-store');
  if(req.method!=='GET')return json(res,405,{error:'Read only'},req);
  const email=serviceOwnerEmail(req);
  if(!email)return json(res,403,{error:'Service owner access required'},req);
  const query=new URL(req.url??'', 'http://localhost').searchParams;
  const rawPage=query.get('page')??'0';
  if(!/^\d{1,6}$/.test(rawPage))return json(res,400,{error:'Invalid page'},req);
  const port=Number(process.env.QOOPIA_OWNER_BRIDGE_PORT??'3740');
  if(!Number.isSafeInteger(port)||port<1||port>65535)return json(res,503,{error:'Owner panel unavailable'},req);
  try{
    const response=await request(`http://127.0.0.1:${port}/internal/owner`,{
      method:'POST',headers:{authorization:'Bearer '+process.env.QOOPIA_OWNER_BRIDGE_SECRET,'content-type':'application/json'},
      body:JSON.stringify({email,lang:query.get('lang')==='ru'?'ru':'en',page:Number(rawPage)}),
      redirect:'error',signal:AbortSignal.timeout(8000),
    });
    if(!response.ok)return json(res,response.status===403?403:503,{error:'Owner panel unavailable'},req);
    const value=await response.json() as {html?:unknown};
    if(typeof value.html!=='string'||value.html.length>1_000_000)return json(res,502,{error:'Owner panel unavailable'},req);
    return json(res,200,{html:value.html},req);
  }catch{return json(res,503,{error:'Owner panel unavailable'},req);}
}
