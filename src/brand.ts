import {readFileSync} from 'node:fs';
import {assetPath} from './utils/assets.ts';
const files:Record<string,string>={
  'i18n.js':'text/javascript; charset=utf-8','base.css':'text/css; charset=utf-8','tokens.css':'text/css; charset=utf-8',
  'MarckScript-Regular.ttf':'font/ttf','IBMPlexSans.ttf':'font/ttf',
  'logo/qoopia-mark.svg':'image/svg+xml','logo/qoopia-mark-small.svg':'image/svg+xml',
  'logo/qoopia-favicon.svg':'image/svg+xml',
  'logo/motif-underline.svg':'image/svg+xml',
};
export function brandAsset(path:string){
  if(!path.startsWith('/brand/'))return;
  const name=path.slice(7),type=files[name];
  if(!Object.hasOwn(files,name))return;
  return {body:readFileSync(assetPath('src/public/brand/'+name)),type};
}
export const brandHead='<link rel="icon" type="image/svg+xml" href="/brand/logo/qoopia-favicon.svg?v=contrast-3"><link rel="stylesheet" href="/brand/base.css">';
export const brandLockup='<div class="q-brand"><img src="/brand/logo/qoopia-mark.svg" width="40" height="36" alt=""><span class="q-wordmark">Qoopia</span></div>';
