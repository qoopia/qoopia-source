// Subprocess for tests/embedding-freshness.test.ts [M8]. The maintenance pass keeps its pace in module
// state and tests/setup.ts turns automatic embedding off, so the pass only runs in a fresh process.
// No model is needed: a local endpoint stands in for the embedder and fails on request.
if(!process.env.QOOPIA_ROOT?.includes('qoopia-embed-backfill-'))
  throw new Error('Run through tests/embedding-freshness.test.ts with an isolated root');
let down=true;const asked:string[]=[];
const server=Bun.serve({port:0,async fetch(req){
  const text=String((await req.json() as {input?:unknown}).input);asked.push(text);
  return down||text.includes('POISON')?new Response('broken',{status:500}):Response.json({embeddings:[Array(1024).fill(0.1)]});}});
process.env.QOOPIA_EMBED_ENDPOINT=`http://127.0.0.1:${server.port}/api/embed`;
const {db,closeDb}=await import('../../src/db/connection.ts');
const {runMigrations}=await import('../../src/db/migrate.ts');runMigrations();
const {createWorkspace}=await import('../../src/admin/workspaces.ts'),{createAgent}=await import('../../src/admin/agents.ts');
const {createNote}=await import('../../src/services/notes.ts'),{processMemoryMaintenance}=await import('../../src/services/continuity.ts');
const ws=createWorkspace({name:'Embedding backfill',slug:'embed-backfill'}),agent=createAgent({name:'probe',workspaceSlug:ws.slug}).id;
const embedded=()=>(db.query('SELECT COUNT(*) AS c FROM notes_embeddings').get() as {c:number}).c;
const settle=async(done:()=>boolean,ms=4000)=>{const end=Date.now()+ms;while(!done()&&Date.now()<end)await Bun.sleep(25);await Bun.sleep(150);};
const pass=async(done:()=>boolean=()=>false,ms=300)=>{asked.length=0;await processMemoryMaintenance();await settle(done,ms);return asked.length;};

// Written while the embedder is down: nothing is indexed at write time, all of it is left to the pass.
for(let i=0;i<4;i++)createNote({workspace_id:ws.id,agent_id:agent,text:`older note ${i}`});
createNote({workspace_id:ws.id,agent_id:agent,text:'POISON the newest note, which the embedder never takes'});
await settle(()=>asked.length>=5);
// The embedder is back. The newest note still fails; the four behind it must be indexed all the same.
down=false;
const firstAsked=await pass(()=>embedded()>=4,4000);
const first={embedded:embedded(),asked:firstAsked};
// The failing note waits on its own: the next passes do not ask for it again.
const again=await pass()+await pass();
// The embedder itself is down: three failures in a row end the pass, and the next one waits.
down=true;
for(let i=0;i<6;i++)createNote({workspace_id:ws.id,agent_id:agent,text:`later note ${i}`});
await settle(()=>asked.length>=6);
const outage=await pass(()=>asked.length>=3,2000),paused=await pass();
console.log(JSON.stringify({first,again,outage,paused}));
server.stop(true);closeDb();
