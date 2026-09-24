import {test,expect,beforeAll} from 'bun:test';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {createAgent} from '../src/admin/agents.ts';
import {myAgentAction,myAgentState,agentDirectory,stopMyAgents,expireIdleMyAgentRuns} from '../src/services/my-agent.ts';
import {saveMessage} from '../src/services/sessions.ts';
import {checkpointSession} from '../src/services/continuity.ts';
import {durableWrite,privateDirectory} from '../src/utils/fs.ts';
beforeAll(()=>runMigrations());
async function until(predicate:()=>boolean){const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('Regression fixture timed out');await Bun.sleep(10);}}
function ownerFixture(){
  const slug='rc4-'+randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner=bootstrapOwner(db,'Regression owner',undefined,slug),agent=createAgent({name:'Regression steward',workspaceSlug:slug,type:'steward'});
  db.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)').run(owner.agent_id,slug,agent.id,new Date().toISOString());
  const root=agentDirectory(owner.agent_id);durableWrite(path.join(root,'credentials.json'),JSON.stringify({key:agent.api_key}));
  const bin=privateDirectory(path.join(root,'fixture-bin'));
  durableWrite(path.join(bin,'codex'),'#!'+process.execPath+'\n'+`
    import readline from 'node:readline';import fs from 'node:fs';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
    process.on('SIGTERM',()=>{});
    const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let thread,turn;
    for await(const line of readline.createInterface({input:process.stdin})){
      const m=JSON.parse(line);if(m.method==='initialized')continue;
      fs.appendFileSync('rpc-trace.jsonl',JSON.stringify(m)+'\\n');let result={};
      if(m.method==='model/list')result={data:[{model:'fixture-fast',displayName:'Fixture fast',isDefault:true},{model:'fixture-deep',displayName:'Fixture deep'}]};
      if(m.method==='account/read')result={account:{type:'chatgpt'}};
      if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId??randomUUID();result={thread:{id:thread}};}
      if(m.method==='turn/start'){thread=m.params.threadId;turn=randomUUID();result={turn:{id:turn}};}
      send({id:m.id,result});
      if(m.method==='turn/start'){
        const text=m.params.input[0].text;
        if(text==='run-child'){
          spawn('/bin/sh',['-c',"printf ready > child-ready; sleep 1.5; printf SHOULD_NOT_EXIST > child-finished"],{cwd:process.cwd(),detached:true,stdio:'ignore'});
        }else if(text==='hang'){
          // A native turn that never emits progress or a completion event.
        }else if(text==='stream'){
          send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'First part'}});
          setTimeout(()=>{send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:' and final part'}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});},350);
        }else if(text==='approval'){
          send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,command:'fixture approval'}});
        }else{
          send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'Synthetic response'}});
          send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
        }
      }
    }
  `,0o700);
  return {owner:owner.agent_id,agent:agent.id,workspace:slug,root,bin,cwd:path.join(root,'workspace')};
}

test('streamed text becomes visible during a turn and the final chunk is retained',async()=>{
  const f=ownerFixture(),oldPath=process.env.PATH;
  try{
    process.env.PATH=f.bin+path.delimiter+oldPath;
    const c=await myAgentAction(f.owner,{action:'new',title:'Streaming turn'});
    await myAgentAction(f.owner,{action:'send',conversation:c.id,requestId:'stream-once',text:'stream'});
    await until(()=>myAgentState(f.owner).runs[0]?.answer==='First part');
    expect(myAgentState(f.owner).runs[0]?.state).toBe('running');
    await until(()=>myAgentState(f.owner).runs[0]?.state==='completed');
    expect(myAgentState(f.owner).runs[0]?.answer).toBe('First part and final part');
  }finally{await stopMyAgents();process.env.PATH=oldPath;}
});

test('an unresponsive native turn ends with a visible failure and releases its process',async()=>{
  const f=ownerFixture(),oldPath=process.env.PATH;
  try{
    process.env.PATH=f.bin+path.delimiter+oldPath;
    const c=await myAgentAction(f.owner,{action:'new',title:'Idle turn'});
    await myAgentAction(f.owner,{action:'send',conversation:c.id,requestId:'hang-once',text:'hang'});
    expect(myAgentState(f.owner).active_conversation).toBe(c.id);
    expireIdleMyAgentRuns(Date.now()+15*60_000+1000);
    await until(()=>!myAgentState(f.owner).running);
    expect(myAgentState(f.owner).runs[0]).toMatchObject({state:'failed',error:'The agent stopped responding for 15 minutes. Start a new turn to continue.'});
  }finally{await stopMyAgents();process.env.PATH=oldPath;}
});

test('dashboard Stop kills detached tool descendants, preserves unrelated processes, and resumes without replay',async()=>{
  const f=ownerFixture(),oldPath=process.env.PATH;let control:ReturnType<typeof spawn>|undefined;
  try{
    process.env.PATH=f.bin+path.delimiter+oldPath;
    const c=await myAgentAction(f.owner,{action:'new',title:'Stop regression'});
    const run=await myAgentAction(f.owner,{action:'send',conversation:c.id,requestId:'stop-once',text:'run-child'});
    await until(()=>fs.existsSync(path.join(f.cwd,'child-ready')));
    control=spawn('/bin/sh',['-c','sleep 1.7; printf control > unrelated-finished'],{cwd:f.cwd,stdio:'ignore'});
    await myAgentAction(f.owner,{action:'stop'});
    expect(myAgentState(f.owner).runs[0]!.state).toBe('interrupted');
    expect(myAgentState(f.owner).running).toBe(false);
    await myAgentAction(f.owner,{action:'send',conversation:c.id,requestId:'next',text:'next independent turn'});
    await until(()=>myAgentState(f.owner).runs.at(-1)?.state==='completed');
    await until(()=>fs.existsSync(path.join(f.cwd,'unrelated-finished')));
    expect(fs.existsSync(path.join(f.cwd,'child-finished'))).toBe(false);
    const trace=fs.readFileSync(path.join(f.cwd,'rpc-trace.jsonl'),'utf8').trim().split('\n').map(v=>JSON.parse(v));
    expect(trace.filter(m=>m.method==='turn/start'&&m.params.input[0].text==='run-child')).toHaveLength(1);
    expect(trace.some(m=>m.method==='thread/resume')).toBe(true);
    expect(db.query('SELECT state FROM qoopia_agent_runs WHERE id=?').get(run.id)).toEqual({state:'interrupted'});
    await myAgentAction(f.owner,{action:'send',conversation:c.id,requestId:'pending',text:'approval'});
    await until(()=>myAgentState(f.owner).approvals.length===1);
    const approval=myAgentState(f.owner).approvals[0]!.id;
    await myAgentAction(f.owner,{action:'stop'});
    await expect(myAgentAction(f.owner,{action:'approve',id:approval,accept:true})).rejects.toThrow('expired');
  }finally{await stopMyAgents();control?.kill('SIGKILL');process.env.PATH=oldPath;}
},15000);

test('new dashboard thread receives the selected saved context; snapshot survives restart and excludes other branches',async()=>{
  const f=ownerFixture(),foreign=ownerFixture(),oldPath=process.env.PATH;
  const seed=(id:string,text:string,target=f)=>saveMessage({workspace_id:target.workspace,agent_id:target.agent,session_id:id,role:'user',content:text});
  try{
    process.env.PATH=f.bin+path.delimiter+oldPath;
    const a=await myAgentAction(f.owner,{action:'new',title:'Cedar project'});
    seed(a.id,'Cedar harbour 593: violet emblem, seven benches, Saturday opening. Next: lighting plan.');
    await checkpointSession(f.workspace,f.agent,a.id,async()=>({text:'Cedar harbour 593: violet emblem; seven benches; Saturday opening. Next: lighting plan.',model:'synthetic-summary'}));
    seed(a.id,'Unsummarized decision: lighting must be warm.');
    const b=await myAgentAction(f.owner,{action:'new',title:'Continue with context'});
    // Both a later edit in A and an unrelated owner must stay out of B's snapshot.
    seed(a.id,'LATER_BRANCH_ONLY');
    const x=await myAgentAction(foreign.owner,{action:'new',title:'Private foreign task'});seed(x.id,'FOREIGN_OWNER_ONLY',foreign);
    await expect(myAgentAction(f.owner,{action:'select-conversation',conversation:x.id})).rejects.toThrow('not found');
    await myAgentAction(f.owner,{action:'send',conversation:b.id,requestId:'first',text:'What were our decisions and next step?'});
    await until(()=>myAgentState(f.owner).runs.at(-1)?.state==='completed');
    await stopMyAgents();
    await myAgentAction(f.owner,{action:'send',conversation:b.id,requestId:'after-restart',text:'Continue after restart'});
    await until(()=>myAgentState(f.owner).runs.at(-1)?.state==='completed');
    const starts=fs.readFileSync(path.join(f.cwd,'rpc-trace.jsonl'),'utf8').trim().split('\n').map(v=>JSON.parse(v)).filter(m=>['thread/start','thread/resume'].includes(m.method));
    expect(starts).toHaveLength(2);
    for(const m of starts){
      const instructions=m.params.developerInstructions;
      expect(instructions).toContain('Cedar harbour 593');expect(instructions).toContain('lighting must be warm');
      expect(instructions).toContain('Current user instructions take precedence');
      expect(instructions).not.toContain('LATER_BRANCH_ONLY');expect(instructions).not.toContain('FOREIGN_OWNER_ONLY');
    }
    expect(starts[0].params.developerInstructions).toBe(starts[1].params.developerInstructions);
    // The memory model receives the same prior working state when it creates
    // the first checkpoint for B; an empty intermediate conversation retains it.
    let summaryInput:any;
    await checkpointSession(f.workspace,f.agent,b.id,async(_workspace,_prompt,input)=>{summaryInput=input;return {text:'Cedar harbour 593; next: lighting plan.',model:'synthetic-summary'};});
    expect(summaryInput.previous).toContain('Cedar harbour 593');
    const empty=await myAgentAction(f.owner,{action:'new',title:'Empty intermediate conversation'});
    const next=await myAgentAction(f.owner,{action:'new',title:'After empty intermediate'});
    const nextContext=JSON.parse((db.query('SELECT metadata FROM sessions WHERE id=?').get(next.id) as any).metadata).dashboard_context;
    expect(nextContext.source_session).toBe(empty.id);expect(nextContext.context).toContain('Cedar harbour 593');
    // Provider selection is an independent context boundary.
    db.query("UPDATE qoopia_agent_settings SET provider='claude_code' WHERE owner_id=?").run(f.owner);
    const isolated=await myAgentAction(f.owner,{action:'new',title:'Independent provider'});
    expect(JSON.parse((db.query('SELECT metadata FROM sessions WHERE id=?').get(isolated.id) as any).metadata).dashboard_context).toBeUndefined();
  }finally{await stopMyAgents();process.env.PATH=oldPath;}
},15000);

test('owner model selection reaches Codex turns, rejects unknown models and cannot change an active task',async()=>{
  const f=ownerFixture(),oldPath=process.env.PATH;
  try {
    process.env.PATH=f.bin+path.delimiter+oldPath;
    await myAgentAction(f.owner,{action:'start'});
    expect((await myAgentAction(f.owner,{action:'models'})).models).toHaveLength(2);
    await expect(myAgentAction(f.owner,{action:'model',model:'not-in-catalog'})).rejects.toThrow('available');
    await myAgentAction(f.owner,{action:'model',model:'fixture-deep'});
    const c=await myAgentAction(f.owner,{action:'new',title:'Model selection'});
    await myAgentAction(f.owner,{action:'send',conversation:c.id,requestId:'model-turn',text:'approval'});
    await until(()=>myAgentState(f.owner).approvals.length===1);
    expect(myAgentState(f.owner).model).toBe('fixture-deep');
    const trace=fs.readFileSync(path.join(f.cwd,'rpc-trace.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(trace.find(m=>m.method==='turn/start').params.model).toBe('fixture-deep');
    await expect(myAgentAction(f.owner,{action:'model',model:'fixture-fast'})).rejects.toThrow('current task');
    expect(myAgentState(f.owner).model).toBe('fixture-deep');
  }finally{await stopMyAgents();process.env.PATH=oldPath;}
});
