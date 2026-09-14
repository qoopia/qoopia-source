import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {prepareNews,previewNews,sendNews} from '../src/identity/news-sender.ts';

if(import.meta.main){
 process.umask(0o077);
 const [command,...args]=process.argv.slice(2),dbFile=process.env.QOOPIA_LOGIN_DB;
 if(!['prepare','preview','send'].includes(command??'')||!dbFile){
  console.log('Set QOOPIA_LOGIN_DB. Commands: prepare <subject.txt> <body.txt> <en|ru>; preview <campaign-id>; send <campaign-id> --confirm <same-id>. Sending also requires QOOPIA_NEWS_POSTAL_ADDRESS, QOOPIA_NEWS_FROM and RESEND_API_KEY. No automatic sending.');
  process.exitCode=1;
 }else{
  const db=new Database(dbFile,{readwrite:true,create:false});db.exec('PRAGMA busy_timeout=5000');
  try{
   if(command==='prepare'){
    if(args.length!==3||!['en','ru'].includes(args[2]!))throw new Error('Use prepare <subject.txt> <body.txt> <en|ru>');
    const id=prepareNews(db,readFileSync(args[0]!,'utf8'),readFileSync(args[1]!,'utf8'),args[2] as 'en'|'ru');console.log(JSON.stringify({campaign_id:id,...previewNews(db,id)}));
   }else if(command==='preview')console.log(JSON.stringify(previewNews(db,args[0]??'')));
   else{
    if(args.length!==3||args[1]!=='--confirm'||args[0]!==args[2])throw new Error('Explicit campaign confirmation required');
    console.log(JSON.stringify(await sendNews(db,args[0]!,{origin:process.env.QOOPIA_LOGIN_ORIGIN??'https://auth.qoopia.ai',from:process.env.QOOPIA_NEWS_FROM??'',postalAddress:process.env.QOOPIA_NEWS_POSTAL_ADDRESS??'',resendKey:process.env.RESEND_API_KEY??''})));
   }
  }catch(error){console.error(error instanceof Error?error.message:'NEWS_COMMAND_FAILED');process.exitCode=1;}finally{db.close();}
 }
}
