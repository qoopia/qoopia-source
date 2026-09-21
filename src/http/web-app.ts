import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {assetPath} from '../utils/assets.ts';

/** Public application shell only. No workspace data or credentials enter an offline cache. */
export function webAppAsset(path:string):{body:string;type:string}|undefined {
 const routes:Record<string,[string,string]>={
  '/manifest.webmanifest':['app.webmanifest','application/manifest+json'],
  '/sw.js':['app-sw.js','text/javascript; charset=utf-8'],
  '/offline':['offline.html','text/html; charset=utf-8'],
 };
 if(!Object.hasOwn(routes,path))return;
 const [file,type]=routes[path];
 let body=readFileSync(assetPath('src/public/'+file),'utf8');
 if(path==='/sw.js'){
  const revision=createHash('sha256');
  for(const name of ['dashboard.html','app-sw.js','offline.html','brand/Manrope.ttf','brand/app.js','brand/dashboard.js','brand/dashboard.css','brand/agent-chat.js','brand/agent-chat.css'])revision.update(readFileSync(assetPath('src/public/'+name)));
  body=body.replaceAll('__QOOPIA_APP_REVISION__',revision.digest('hex').slice(0,16));
 }
 return {body,type};
}
