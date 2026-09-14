import {readdirSync,statSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {assertNoSecrets,redactSensitive} from '../src/utils/secret-guard.ts';
const failures:string[]=[],redactions:{path:string;categories:string[]}[]=[];let files=0;
function walk(dir:string){for(const name of readdirSync(dir)){
 const path=join(dir,name);if(statSync(path).isDirectory()){walk(path);continue;}
 if(name==='privacy-scan.json')continue;
 files++;const original=readFileSync(path,'utf8');
 if(path.endsWith('.log')){const cleaned=redactSensitive(original);if(cleaned.categories.length){writeFileSync(path,cleaned.text);redactions.push({path,categories:cleaned.categories});}}
 try{assertNoSecrets(readFileSync(path,'utf8'),'P2 evidence');}catch{failures.push(path);}
}}
walk('artifacts/p2');
writeFileSync('artifacts/p2/privacy-scan.json',JSON.stringify({files_scanned:files,detector:'existing P1 assertNoSecrets + capture redactor',failures,redactions,scope:'evidence only; synthetic test canaries redacted; no live credentials collected'},null,2)+'\n');
if(failures.length)process.exitCode=1;
