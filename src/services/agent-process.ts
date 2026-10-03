import {execFile,spawn,spawnSync,type ChildProcess,type ChildProcessWithoutNullStreams} from 'node:child_process';

type ProcessRow={pid:number;parent:number;group:number;state:string;started:string};
const stoppedTrees=new WeakMap<ChildProcess,Map<number,ProcessRow>>();
// Metadata only. Never collect command lines, environments or credentials.
const PS_ARGS=['-axo','pid=,ppid=,pgid=,stat=,lstart='];
const PS_OPTIONS={encoding:'utf8' as const,timeout:2000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}};
function rows(stdout:string):ProcessRow[] {
  return stdout.trim().split('\n').flatMap(line=>{
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return m?[{pid:Number(m[1]),parent:Number(m[2]),group:Number(m[3]),state:m[4]!,started:m[5]!}]:[];
  });
}
function processes():ProcessRow[] {
  const result=spawnSync('/bin/ps',PS_ARGS,PS_OPTIONS);
  if(result.status!==0)throw new Error('Cannot verify agent process termination');
  return rows(result.stdout);
}
function signal(pid:number,value:NodeJS.Signals) {
  try{process.kill(pid,value);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw new Error('Cannot stop an agent process');}
}

/** Process groups each agent tree has used, kept only while a member is alive (a dead
 * group's id may be reused). A tool shell that runs `cmd &` and exits leaves cmd under
 * PID 1 but still in the shell's group, so Stop finds it through this record.
 * ponytail: sampled every 2 s, so a shell that backgrounds a job and exits sooner is
 * not seen; a Linux PID namespace or cgroup would close that gap. */
const groups=new Map<ChildProcess,Set<number>>();
let sampler:ReturnType<typeof setInterval>|undefined;
function sample() {
  execFile('/bin/ps',PS_ARGS,PS_OPTIONS,(error,stdout)=>{
    if(error)return;
    const list=rows(stdout),live=new Set(list.map(p=>p.group));
    for(const [child,seen] of groups){
      const tree=new Set(child.pid&&child.exitCode===null&&child.signalCode===null?[child.pid]:[]);
      for(let size=-1;size!==tree.size;){size=tree.size;for(const p of list)if(tree.has(p.parent))tree.add(p.pid);}
      for(const p of list)if(tree.has(p.pid))seen.add(p.group);
      for(const group of seen)if(!live.has(group))seen.delete(group);
      if(!seen.size&&!tree.size)groups.delete(child);
    }
    if(!groups.size){clearInterval(sampler);sampler=undefined;}
  });
}
/** The agent root gets its own session and process group, so its group is never Qoopia's. */
export function spawnAgentProcess(binary:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv}):ChildProcessWithoutNullStreams {
  const child=spawn(binary,args,{...options,stdio:'pipe',detached:true});
  if(child.pid){groups.set(child,new Set([child.pid]));if(!sampler){sampler=setInterval(sample,2000);sampler.unref();}}
  return child;
}

/** Stop only this managed child and its descendants, including tool shells in
 * separate process groups and jobs those shells left behind in their groups.
 * Freeze parents before enumeration so a shell cannot spawn its next command
 * while we are stopping the tree. Do not use pkill/name matching: another
 * user's Codex/Claude process must never be affected, nor Qoopia's own group. */
export async function terminateAgentProcess(child:ChildProcess):Promise<void> {
  const pid=child.pid;
  if(!pid)return;
  const retained=stoppedTrees.get(child);
  if(process.platform!=='darwin'&&process.platform!=='linux')throw new Error('Agent termination is unsupported on this platform');
  const frozen=retained??new Map<number,ProcessRow>();
  stoppedTrees.set(child,frozen);
  if(!retained)try {
    // A reaped root's pid may already belong to someone else; then only its groups identify the tree.
    if(child.exitCode===null&&child.signalCode===null&&signal(pid,'SIGSTOP')){const root=processes().find(p=>p.pid===pid);if(root)frozen.set(pid,root);}
    const seen=new Set(groups.get(child));
    for(let depth=0;depth<64;depth++) {
      const list=processes(),own=list.find(p=>p.pid===process.pid)?.group;
      if(own===undefined)throw new Error('Cannot verify agent process termination');
      const found=list.filter(p=>!frozen.has(p.pid)&&(frozen.has(p.parent)||(seen.has(p.group)&&p.group!==own&&p.group>1)));
      if(!found.length)break;
      for(const p of found)if(signal(p.pid,'SIGSTOP')){frozen.set(p.pid,p);if(p.group!==own)seen.add(p.group);}
      if(depth===63)throw new Error('Agent process tree exceeds the termination limit');
    }
  }catch(error){
    // Enumeration failed: release every suspended process and report failure.
    // Killing parents now would orphan unenumerated children and make a retry
    // incapable of proving termination.
    for(const p of [...frozen.keys()].reverse())try{signal(p,'SIGCONT');}catch{/* Best-effort SIGCONT rollback; the enumeration error is rethrown. */}
    if(!frozen.has(pid)&&child.exitCode===null&&child.signalCode===null)try{signal(pid,'SIGCONT');}catch{/* Best-effort SIGCONT rollback. */}
    stoppedTrees.delete(child);throw error;
  }
  if(!frozen.size){stoppedTrees.delete(child);return;}
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
