import {test,expect} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {dashboardScript} from './helpers/dashboard-source.ts';

// DOM-free: run the dashboard's own functions against stubs, as tests/dashboard-google-login.test.ts does.
const between=(from:string,to:string)=>{const start=dashboardScript.indexOf(from),end=dashboardScript.indexOf(to,start);if(start<0||end<0)throw Error('dashboard marker moved: '+from);return dashboardScript.slice(start,end);};
const router=between('  // ---------- Router ----------','  // Links in generated markup');
const panels=between('  const memoryState = state =>','  // The agent prepared these notes');
const card=(pending:number)=>({id:'a1',name:'Ann',sessions_count:1,messages_count:1,notes_count:1,memory:{mode:'manual',revision:pending,state:'manual',pending_saves:pending}});
function agentDetail(api:(path:string)=>Promise<unknown>){
  const rendered:string[]=[];
  const ctx:any={QI:{msg:(x:string)=>x},esc:(x:unknown)=>String(x??''),fmtTime:String,fmtNum:String,renderNav(){},api,
    state:{page:'agents',drill:{kind:'agent',agent:card(0),tab:'memory'}},agentsCache:[card(0)],pollFn:null,
    renderOverview:()=>rendered.push('overview')};
  ctx.renderAgentDetail=()=>rendered.push(ctx.savesPanel(ctx.state.drill.agent));
  runInNewContext(panels+router,ctx);
  return {ctx,rendered};
}

test('an agent that signed in but sends no conversations reads as connected, not as waiting',()=>{
  const ctx:any={QI:{msg:(x:string)=>x},esc:(x:unknown)=>String(x??'')};runInNewContext(panels,ctx);
  const agent=(last_seen:string|null)=>({memory:{mode:'auto',state:'waiting'},last_seen});
  expect(ctx.coverageLine(agent('2026-10-03T09:07:00Z'))).toContain('Connected · conversations are not saved automatically');
  expect(ctx.coverageLine(agent(null))).toContain('Waiting for this agent to connect');
});

test('Refresh re-reads the open agent, so a save prepared after the page opened is shown',async()=>{
  const {ctx,rendered}=agentDetail(async path=>{expect(path).toBe('/api/dashboard/agents');return {items:[card(1)]};});
  await ctx.route(true);
  expect(ctx.agentsCache).toBeNull();
  expect(ctx.state.drill.agent.memory.revision).toBe(1);
  expect(rendered).toHaveLength(1);expect(rendered[0]).toContain('id="memorySaves"');
});

test('a Refresh that finishes after the user moved on does not render the old agent',async()=>{
  let release!:(v:unknown)=>void;
  const {ctx,rendered}=agentDetail(()=>new Promise(resolve=>release=resolve));
  const done=ctx.route(true);
  const next={page:'overview',drill:null};ctx.state=next;
  release({items:[card(1)]});await done;
  expect(rendered).toEqual([]);expect(ctx.state).toBe(next);
});

test('a failed Refresh keeps the snapshot and still renders the page',async()=>{
  const {ctx,rendered}=agentDetail(async()=>{throw Error('HTTP 500');});
  await ctx.route(true);
  expect(rendered).toHaveLength(1);expect(rendered[0]).not.toContain('memorySaves');
});

const write=between('  async function apiWrite(path, body) {','  // ---------- Auth / boot ----------');
const binders=between('  // The agent prepared these notes','  function renderAgentDetail() {');
function memoryWrites(status:number,description:string){
  const elements:Record<string,any>={'#memoryResult':{textContent:''}};
  const decide:any={dataset:{accept:'1'},disabled:false},saved:any={dataset:{save:'s1'},querySelectorAll:()=>[decide],remove(){}};decide.closest=()=>saved;
  elements['#memorySaves']={insertAdjacentHTML(){},querySelectorAll:(s:string)=>s==='button'?[decide]:[]};
  const refreshed:unknown[]=[];
  const ctx:any={QI:{msg:(x:string)=>x,resolve:(x:string)=>x},esc:String,fmtNum:String,fmtTimeFull:String,BASE:'',AbortSignal,showLogin(){},
    $:(id:string)=>elements[id],state:{drill:{kind:'agent'}},route:async(force:unknown)=>{refreshed.push(force);},api:async()=>({items:[]}),
    fetch:async()=>({ok:false,status,json:async()=>({error:'x',error_description:description})})};
  runInNewContext(write+binders,ctx);
  const agent={id:'a1',memory:{mode:'auto',revision:0,pending_saves:1}};
  return {ctx,agent,decide,refreshed,result:elements['#memoryResult']};
}

test('a save request that is no longer held reports why and re-reads the agent',async()=>{
  const h=memoryWrites(404,'This save request is no longer held. Ask the agent to prepare it again.');await h.ctx.bindMemorySaves(h.agent);await h.decide.onclick();
  expect(h.result.textContent).not.toContain('Only the workspace owner');expect(h.result.textContent).toContain('no longer held');
  expect(h.refreshed).toEqual([true]);
});

test('only a 403 keeps the owner-only explanation',async()=>{
  const save=memoryWrites(403,'Only the workspace owner reviews what a manual agent asked to save');await save.ctx.bindMemorySaves(save.agent);await save.decide.onclick();
  expect(save.result.textContent).toBe('Could not complete this. Only the workspace owner can confirm a save.');expect(save.decide.disabled).toBe(false);
  expect(save.refreshed).toEqual([]);
});

const search=between('  // ================= GLOBAL SEARCH =================','  async function doGlobalSearch(q) {');
function searchPage(api:()=>Promise<unknown>){
  const conn:boolean[]=[];
  const ctx:any={QI:{msg:(x:string)=>x},setCrumb(){},setConn:(ok:boolean)=>conn.push(ok),api,main:{innerHTML:'before'},$:()=>({focus(){}}),state:{page:'search'},agentsCache:null};
  runInNewContext(search,ctx);
  return {ctx,conn};
}

test('a failed agent load on Search shows an error with Retry, not "Searches 0 agents"',async()=>{
  const {ctx,conn}=searchPage(async()=>{throw Error('HTTP 500');});
  await ctx.renderSearchPage();
  expect(ctx.main.innerHTML).toContain('class="err"');expect(ctx.main.innerHTML).toContain('Failed to load agents.');expect(ctx.main.innerHTML).toContain('data-route');
  expect(ctx.main.innerHTML).not.toContain('agents you can access');expect(conn).toEqual([false]);expect(ctx.agentsCache).toBeNull();
});

test('a Search load that fails after sign-out or after the user moved on leaves the page alone',async()=>{
  const signedOut=searchPage(async()=>{throw Error('unauthorized');});
  await signedOut.ctx.renderSearchPage();expect(signedOut.ctx.main.innerHTML).toBe('before');
  let fail!:(e:Error)=>void;
  const moved=searchPage(()=>new Promise((_,reject)=>fail=reject));
  const done=moved.ctx.renderSearchPage();moved.ctx.state.page='overview';fail(Error('HTTP 500'));await done;
  expect(moved.ctx.main.innerHTML).toBe('before');expect(moved.conn).toEqual([]);
});
