import { materializeOwned } from '../../src/skills/native.ts';
import { canonical,digest } from '../../src/skills/commands.ts';
const [root,boundary]=process.argv.slice(2);
const files=new Map([['SKILL.md',Buffer.from('new instructions')],['assets/data.txt',Buffer.from('new data')]]);
const map=Object.fromEntries([...files].map(([n,b])=>[n,{sha256:digest(b),size:b.length}]));
materializeOwned({root,installation:'fixture',runtime:'runtime',target:'skills/sample',skill_id:'skill',version_id:'new',projection_digest:digest(canonical(map)),operation_id:'update',epoch:2,files,guard:()=>{},fault:b=>{if(b===boundary)process.kill(process.pid,'SIGKILL');}});
