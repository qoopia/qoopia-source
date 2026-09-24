import type {Database} from 'bun:sqlite';
import {createHash,timingSafeEqual} from 'node:crypto';
import {ownerPortal,type OwnerOptions} from './owner.ts';

/** The private account store stays on the account service. No browser credential crosses domains. */
export function internalOwnerBridge(db:Database,options:OwnerOptions,secret:string|undefined){
  const reject=(status:number)=>Response.json({error:'FORBIDDEN'},{status,headers:{'cache-control':'no-store'}});
  return async(req:Request):Promise<Response>=>{
    const url=new URL(req.url);
    if(req.method!=='POST'||url.pathname!=='/internal/owner'||url.hostname!=='127.0.0.1'||
      !secret||Buffer.byteLength(secret)<32||!options.accountId)return reject(404);
    const header=req.headers.get('authorization')??'';
    const supplied=header.startsWith('Bearer ')?header.slice(7):'';
    if(!supplied||!timingSafeEqual(createHash('sha256').update(secret).digest(),createHash('sha256').update(supplied).digest()))return reject(403);
    let input:{email?:unknown;lang?:unknown;page?:unknown};
    try{
      if(req.headers.get('content-type')!=='application/json'||Number(req.headers.get('content-length')??0)>512)return reject(400);
      const body=await req.text();if(body.length>512)return reject(400);
      input=JSON.parse(body);
    }catch{return reject(400);}
    const account=db.query('SELECT id,email FROM connection_accounts WHERE id=?').get(options.accountId) as {id:string;email:string}|null;
    if(!account||input?.email!==account.email)return reject(403);
    const lang=input.lang==='ru'?'ru':'en';
    const page=Number.isSafeInteger(input.page)&&Number(input.page)>=0?Number(input.page):0;
    const embeddedPage=(_title:string,html:string,_script='',status=200)=>Response.json({html},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    return ownerPortal(db,embeddedPage,options,true)(new Request(`https://auth.qoopia.ai/owner?lang=${lang}&page=${page}`),account);
  };
}
