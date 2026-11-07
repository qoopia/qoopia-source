import fs from 'node:fs';

/** A zombie has exited but has not been reaped by init. kill(pid, 0) alone
 * reports it as present in containers; it cannot execute work or hold pipes. */
export function processAlive(pid:number):boolean {
  try {process.kill(pid,0);}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
  if(process.platform==='linux') {
    try {
      const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
      return stat.slice(stat.lastIndexOf(')')+1).trimStart()[0]!=='Z';
    }catch(error){return (error as NodeJS.ErrnoException).code!=='ENOENT';}
  }
  return true;
}
