import {readFileSync,writeFileSync} from 'node:fs';
const base=new URL('../',import.meta.url);
const catalog=JSON.parse(readFileSync(new URL('src/public/brand/i18n.ru.json',base),'utf8'));
const template=readFileSync(new URL('scripts/ui/i18n-runtime.js',base),'utf8');
const output=template.replace('__CATALOG__',JSON.stringify(catalog));
// One catalog, one runtime: the dashboard and qoopia.ai serve the same generated file.
for(const path of ['src/public/brand/i18n.js','marketing-site/brand/i18n.js']){
 const file=new URL(path,base);
 if(process.argv.includes('--check')){
  if(readFileSync(file,'utf8')!==output)throw Error('Run bun scripts/build-ui-locales.ts and commit the generated locale runtime ('+path+')');
 }else writeFileSync(file,output);
}
