import {spawnSync, type ChildProcess} from 'node:child_process';

type ProcessRow={pid:number;parent:number;state:string;started:string};
const stoppedTrees=new WeakMap<ChildProcess,Map<number,ProcessRow>>();
function processes():ProcessRow[] {
  // Metadata only. Never collect command lines, environments or credentials.
  const result=spawnSync('/bin/ps',['-axo','pid=,ppid=,stat=,lstart='],{encoding:'utf8',timeout:2000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
  if(result.status!==0)throw new Error('Cannot verify agent process termination');
  return result.stdout.trim().split('\n').flatMap(line=>{
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return m?[{pid:Number(m[1]),parent:Number(m[2]),state:m[3]!,started:m[4]!}]:[];
  });
}
function signal(pid:number,value:NodeJS.Signals) {
  try{process.kill(pid,value);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw new Error('Cannot stop an agent process');}
}

/** Stop only this managed child and its descendants, including tool shells in
 * separate process groups. Freeze parents before enumeration so a shell cannot
 * spawn its next command while we are stopping the tree. Do not use pkill/name
 * matching: another user's Codex/Claude process must never be affected. */
export async function terminateAgentProcess(child:ChildProcess):Promise<void> {
  const pid=child.pid;
  if(!pid)return;
  const retained=stoppedTrees.get(child);
  if(!retained&&(child.exitCode!==null||child.signalCode!==null))return;
  if(process.platform!=='darwin'&&process.platform!=='linux')throw new Error('Agent termination is unsupported on this platform');
  const frozen=retained??new Map<number,ProcessRow>();
  stoppedTrees.set(child,frozen);
  if(!retained)try {
      if(!signal(pid,'SIGSTOP')){stoppedTrees.delete(child);return;}
      const root=processes().find(p=>p.pid===pid);
      if(!root){stoppedTrees.delete(child);return;}
      frozen.set(pid,root);
    for(let depth=0;depth<64;depth++) {
      const children=processes().filter(p=>!frozen.has(p.pid)&&frozen.has(p.parent));
      if(!children.length)break;
      for(const p of children)if(signal(p.pid,'SIGSTOP'))frozen.set(p.pid,p);
      if(depth===63)throw new Error('Agent process tree exceeds the termination limit');
    }
  }catch(error){
    // Enumeration failed: release every suspended process and report failure.
    // Killing parents now would orphan unenumerated children and make a retry
    // incapable of proving termination.
    for(const p of [...frozen.keys()].reverse())try{signal(p,'SIGCONT');}catch{}
    if(!frozen.has(pid))try{signal(pid,'SIGCONT');}catch{}
    stoppedTrees.delete(child);throw error;
  }
  // SIGKILL also handles a tool that ignores SIGTERM. Children are killed before
  // their frozen parents, preserving ancestry until every signal is dispatched.
  const current=retained?processes():null;
  let failure:unknown;
  for(const p of [...frozen.values()].reverse())if(!current||current.some(row=>row.pid===p.pid&&row.started===p.started))try{signal(p.pid,'SIGKILL');}catch(error){failure=error;}
  if(failure)throw failure;
  const deadline=Date.now()+3000;
  while(true) {
    const remaining=processes().filter(p=>frozen.get(p.pid)?.started===p.started&&!p.state.startsWith('Z'));
    if(!remaining.length){stoppedTrees.delete(child);return;}
    if(Date.now()>=deadline)throw new Error('Agent processes have not stopped; do not start another task yet');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
