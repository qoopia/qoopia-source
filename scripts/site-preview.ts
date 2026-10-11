/** Isolated marketing/account preview. Never calls email or live identity providers. */
import fs from 'node:fs';import path from 'node:path';import {Database} from 'bun:sqlite';
import {loginBroker} from '../src/identity/broker.ts';
const out=process.argv[process.argv.indexOf('--out')+1];
if(!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Use --out ABSOLUTE_NEW_DIRECTORY');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const db=new Database(':memory:');
let origin='';const broker=loginBroker(db,{origin:'https://fixture.qoopia.test',resendKey:'fixture',from:'fixture@example.test',googleClientId:'fixture',googleClientSecret:'fixture'},(async()=>{throw Error('External identity calls disabled in preview');}) as unknown as typeof fetch);
const root=path.resolve('marketing-site');
const csp=fs.readFileSync(path.join(root,'_headers'),'utf8').split('Content-Security-Policy: ')[1]!.split('\n')[0]!.trim();
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const url=new URL(req.url);
 if(url.pathname==='/profile')return broker(new Request('https://fixture.qoopia.test/profile'+url.search),'fixture');
 // Same lookup as Cloudflare Pages: /ru → /ru/, /ru/ → ru/index.html, /docs → docs.html, a miss → the nearest 404.html.
 const inside=(file:string)=>file.startsWith(root+path.sep)&&!path.relative(root,file).split(path.sep).some(part=>part.startsWith('_')||part.startsWith('.'));
 const headers={'cache-control':'no-store','content-security-policy':csp};
 const base=path.resolve(root,'.'+url.pathname);
 if(inside(base)&&!url.pathname.endsWith('/')&&fs.existsSync(base)&&fs.statSync(base).isDirectory())return Response.redirect(origin+url.pathname+'/'+url.search,308);
 const name=url.pathname.endsWith('/')?url.pathname+'index.html':path.extname(url.pathname)?url.pathname:url.pathname+'.html';
 const file=path.resolve(root,'.'+name);
 if(inside(file)&&fs.existsSync(file)&&fs.statSync(file).isFile())return new Response(Bun.file(file),{headers});
 for(let dir=path.dirname(file);inside(path.join(dir,'404.html'));dir=path.dirname(dir))if(fs.existsSync(path.join(dir,'404.html')))return new Response(Bun.file(path.join(dir,'404.html')),{status:404,headers});
 return new Response('Not found',{status:404});
}});origin='http://127.0.0.1:'+server.port;
fs.writeFileSync(path.join(out,'preview.json'),JSON.stringify({fixture:'qoopia-website-preview/1',url:origin}),{mode:0o600});console.log(origin);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.stop(true);db.close();process.exit(0);});
