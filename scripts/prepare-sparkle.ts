import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const SPARKLE={version:'2.10.0',url:'https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz',sha256:'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c'};
export async function prepareSparkle(){
 const directory=path.resolve('.cache/sparkle-'+SPARKLE.version),file=path.join(directory,'archive.tar.xz');
 fs.mkdirSync(directory,{recursive:true});
 if(!fs.existsSync(file)){
  const response=await fetch(SPARKLE.url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Sparkle download failed');
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>32*1024*1024||createHash('sha256').update(bytes).digest('hex')!==SPARKLE.sha256)throw new Error('Sparkle checksum mismatch');
  fs.writeFileSync(file,bytes);
 }
 if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==SPARKLE.sha256)throw new Error('Sparkle checksum mismatch');
 return file;
}
if(import.meta.main)console.log(await prepareSparkle());
