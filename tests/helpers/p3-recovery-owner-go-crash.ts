import { Delivery } from '../../src/delivery/operations.ts';
import fs from 'node:fs';
import path from 'node:path';
const [root,backup,confirmation,boundary]=process.argv.slice(2);
new Delivery(root!,fs.readFileSync(path.join(root!,'fixture-public.pem'),'utf8'),true,()=>{throw new Error('Unexpected migration');},at=>{if(at===boundary)process.kill(process.pid,'SIGKILL');}).recoverOps(backup!,confirmation);
throw new Error('Crash boundary not reached');
