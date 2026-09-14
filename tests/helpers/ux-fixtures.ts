// Render production templates with synthetic identities. No network or email delivery.
import '../setup.ts';
import {mkdirSync,writeFileSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Database} from 'bun:sqlite';
import {loginBroker} from '../../src/identity/broker.ts';
import {confirmationMail} from '../../src/identity/messages.ts';
import {profileView} from '../../src/identity/profile-view.ts';
import {brandHead,brandLockup} from '../../src/brand.ts';

const out=resolve(process.argv[2]!);mkdirSync(out,{recursive:true});
cpSync('src/public/brand',join(out,'brand'),{recursive:true});
const db=new Database(':memory:'),origin='https://fixture.example.test';
const broker=loginBroker(db,{origin,resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture'},(async()=>{throw Error('No network in UX fixture');}) as typeof fetch);
try{
  for(const lang of ['en','ru'] as const){
    for(const route of ['profile','confirm']){
      const response=await broker(new Request(origin+'/'+route+'?lang='+lang),'fixture');
      writeFileSync(join(out,route+'-'+lang+'.html'),await response.text());
    }
    const mail=confirmationMail(origin+'/confirm?lang='+lang+'#'+'x'.repeat(43),lang);
    writeFileSync(join(out,'mail-'+lang+'.json'),JSON.stringify(mail,null,2));
    writeFileSync(join(out,'mail-'+lang+'.html'),mail.html.replaceAll('cid:qoopia-brand','/brand/email-lockup.png'));
    const page=(title:string,content:string,script='',_status=200,language='en')=>new Response(`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Qoopia</title>${brandHead}<body class="q-auth"><main>${brandLockup}<h1>${title}</h1>${content}</main><script>${script}</script></html>`);
    writeFileSync(join(out,'profile-saved-'+lang+'.html'),await profileView(page,lang==='ru',{email:'synthetic-owner-with-long-address@example.test',url:'https://memory.example.test/dashboard'},'',false).text());
  }
}finally{db.close();}
