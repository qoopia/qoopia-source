import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {loginBroker} from '../src/identity/broker.ts';

test('sign-in language survives broker restart; localized mail retains one-use proof and private inline branding',async()=>{
  const db=new Database(':memory:'),origin='https://identity.example.test';
  const config={origin,resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture'};
  const mails:Array<{subject:string;text:string;html:string;attachments:unknown[]}>=[];
  const provider=(async(url,init)=>{expect(String(url)).toBe('https://api.resend.com/emails');mails.push(JSON.parse(String(init?.body)));return Response.json({id:'synthetic'});}) as typeof fetch;
  let broker=loginBroker(db,config,provider);
  const call=(path:string,body?:unknown)=>broker(new Request(origin+path,{method:body?'POST':'GET',headers:{origin,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}),'fixture');
  try{
    for(const language of ['en','ru']){
      const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('hex');
      const start=await call('/requests',{method:'email',email:language+'@example.test',language,challenge});expect(start.status).toBe(201);
      const {id}=await start.json() as {id:string};
      expect(db.query('SELECT language FROM login_requests WHERE id=?').get(id)).toEqual({language});
      broker=loginBroker(db,config,provider);
      const mail=mails.at(-1)!;expect(mail.subject).toBe(language==='ru'?'Подтвердите вход в Qoopia':'Confirm your sign-in to Qoopia');
      expect(mail.html).toContain('lang="'+language+'"');expect(mail.html).toContain('cid:qoopia-brand');expect(mail.html).not.toMatch(/<img[^>]+src="https?:/);expect(mail.attachments).toHaveLength(1);expect(mail.html).toContain('Manrope');expect(mail.html).not.toContain('IBM Plex');expect(mail.html).toContain('#111110');
      const link=new URL(mail.text.match(/https:\/\/[^\s]+/)![0]);expect(link.searchParams.get('lang')).toBe(language);
      const page=await(await call('/confirm'+link.search)).text();expect(page).toContain('<html lang="'+language+'"');
      expect((await call('/redeem',{id,verifier})).status).toBe(202); // Viewing the page never consumes proof.
      expect((await call('/confirm',{token:link.hash.slice(1)})).status).toBe(200);
      expect((await call('/confirm',{token:link.hash.slice(1)})).status).toBe(400);
      expect((await call('/redeem',{id,verifier})).status).toBe(200);
    }
    expect((await call('/profile/start',{method:'email',email:'profile@example.test',language:'ru'})).status).toBe(200);
    expect(mails.at(-1)!.subject).toBe('Подтвердите вход в Qoopia');
    expect(await(await call('/profile?lang=ru')).text()).toContain('<html lang="ru"');
  }finally{db.close();}
});
