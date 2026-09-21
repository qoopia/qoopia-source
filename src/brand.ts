import {readFileSync} from 'node:fs';
import {assetPath} from './utils/assets.ts';
const files:Record<string,string>={
  'chevron-down.svg':'image/svg+xml',
  'i18n.js':'text/javascript; charset=utf-8','base.css':'text/css; charset=utf-8','tokens.css':'text/css; charset=utf-8',
  'app.js':'text/javascript; charset=utf-8','graphite/icon-180.png':'image/png','graphite/icon-192.png':'image/png','graphite/icon-512.png':'image/png',
  'agent-chat.js':'text/javascript; charset=utf-8','agent-chat.css':'text/css; charset=utf-8',
  'graphite/favicon.svg':'image/svg+xml',
  'Manrope.ttf':'font/ttf','graphite/qoopia-mark-ivory.svg':'image/svg+xml','graphite/qoopia-wordmark-ivory.svg':'image/svg+xml',
  'dashboard.js':'text/javascript; charset=utf-8','dashboard.css':'text/css; charset=utf-8',
  'logo/qoopia-mark.svg':'image/svg+xml','logo/qoopia-mark-small.svg':'image/svg+xml',
  'logo/qoopia-favicon.svg':'image/svg+xml',
  'logo/motif-underline.svg':'image/svg+xml',
};
export function brandAsset(path:string){
  if(!path.startsWith('/brand/'))return;
  const name=path.slice(7),type=files[name];
  if(!Object.hasOwn(files,name))return;
  // A packaging slip must degrade to a plain 404, not a 500 on the page's own stylesheet.
  try{return {body:readFileSync(assetPath('src/public/brand/'+name)),type};}catch{return;}
}
export const brandHead='<link rel="icon" type="image/svg+xml" href="/brand/graphite/favicon.svg"><link rel="stylesheet" href="/brand/base.css">';
export const brandLockup="<span class=\"q-brand\"><img src=\"/brand/graphite/qoopia-mark-ivory.svg\" width=\"28\" height=\"28\" alt=\"\"><img class=\"q-wordmark\" src=\"/brand/graphite/qoopia-wordmark-ivory.svg\" width=\"105\" height=\"28\" alt=\"qoopia\"></span>";
