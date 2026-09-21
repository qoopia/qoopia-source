/** Isolated marketing/account preview. Never calls email or live identity providers. */
import fs from 'node:fs';import path from 'node:path';import {Database} from 'bun:sqlite';
import {loginBroker} from '../src/identity/broker.ts';
const out=process.argv[process.argv.indexOf('--out')+1];
if(!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Use --out ABSOLUTE_NEW_DIRECTORY');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const db=new Database(':memory:');
let origin='';const broker=loginBroker(db,{origin:'https://fixture.qoopia.test',resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture'},(async()=>{throw Error('External identity calls disabled in preview');}) as unknown as typeof fetch);
const root=path.resolve('marketing-site');
const csp=fs.readFileSync(path.join(root,'_headers'),'utf8').split('Content-Security-Policy: ')[1]!.trim();
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const url=new URL(req.url);
 if(url.pathname==='/profile')return broker(new Request('https://fixture.qoopia.test/profile'+url.search),'fixture');
 let name=url.pathname==='/'?'index.html':url.pathname.slice(1);
 if(!path.extname(name))name+='.html';
 const file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()||name.startsWith('_'))return new Response('Not found',{status:404});
 return new Response(Bun.file(file),{headers:{'cache-control':'no-store','content-security-policy':csp}});
}});origin='http://127.0.0.1:'+server.port;
fs.writeFileSync(path.join(out,'preview.json'),JSON.stringify({fixture:'qoopia-website-preview/1',url:origin}),{mode:0o600});console.log(origin);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.stop(true);db.close();process.exit(0);});
