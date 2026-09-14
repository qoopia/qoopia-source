import fs from 'node:fs';
import { Delivery } from '../../src/delivery/operations.ts';
const [root,bundle,key,boundary,operation]=process.argv.slice(2);
const delivery=new Delivery(root!,fs.readFileSync(key!,'utf8'),true,()=>{},point=>{
 if(point===boundary)process.kill(process.pid,'SIGKILL');
});
if(operation==='restore')delivery.restore(bundle!);else delivery.update(bundle!);
