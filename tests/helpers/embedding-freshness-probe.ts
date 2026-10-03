// Subprocess for tests/embedding-freshness.test.ts. EMBED_PROVIDER is fixed at
// module load and tests/setup.ts pins the legacy provider, so the built-in chunk
// loader only runs in a fresh process. No model is needed: vectors are seeded.
if(!process.env.QOOPIA_ROOT?.includes('qoopia-embed-freshness-'))
  throw new Error('Run through tests/embedding-freshness.test.ts with an isolated root');
const {db,closeDb}=await import('../../src/db/connection.ts');
const {runMigrations}=await import('../../src/db/migrate.ts');runMigrations();
const {createWorkspace}=await import('../../src/admin/workspaces.ts'),{createAgent}=await import('../../src/admin/agents.ts');
const {createNote,updateNote}=await import('../../src/services/notes.ts'),{recall}=await import('../../src/services/recall.ts');
const {EMBED_PROVIDER,EMBED_MODEL,EMBED_DIM,textHash,serializeEmbedding}=await import('../../src/services/embeddings.ts');
const store=await import('../../src/services/embedding-store.ts');
const ws=createWorkspace({name:'Embedding freshness',slug:'embed-freshness'}),agent=createAgent({name:'probe',workspaceSlug:ws.slug}).id;

// Count result rows that carry note text: the read-path cost this probe guards.
let textRows=0;const wrapped=new WeakSet<object>();
for(const method of ['query','prepare'] as const){
  const original=db[method].bind(db) as (sql:string)=>any;
  (db as any)[method]=(sql:string)=>{const statement=original(sql);if(!wrapped.has(statement)){wrapped.add(statement);
    for(const read of ['all','get']){const run=statement[read];statement[read]=(...args:unknown[])=>{const result=run.apply(statement,args);
      for(const row of Array.isArray(result)?result:result?[result]:[])if(row&&typeof row==='object'&&'text' in row)textRows++;return result;};}}
    return statement;};
}
const reads=<T>(fn:()=>T)=>{const before=textRows;const value=fn();return {value,text_rows:textRows-before};};

const N=200,CHUNKS=3,filler='память о проекте и плане работ '.repeat(170);
const vector=serializeEmbedding(new Float32Array(EMBED_DIM).fill(1/Math.sqrt(EMBED_DIM)));
const ids:string[]=[];
db.transaction(()=>{for(let i=0;i<N;i++){const text=`note ${i} ${filler}`,id=createNote({workspace_id:ws.id,agent_id:agent,text}).id;ids.push(id);
  db.query('INSERT INTO notes_embeddings(note_id,workspace_id,embedding,dim,model,text_hash) VALUES(?,?,?,?,?,?)').run(id,ws.id,vector,EMBED_DIM,EMBED_MODEL,textHash(text));
  for(let c=0;c<CHUNKS;c++)db.query('INSERT INTO note_embedding_chunks(note_id,chunk_no,start_char,end_char,embedding) VALUES(?,?,?,?,?)').run(id,c,c*1680,(c+1)*1680,vector);}})();
const perNote=EMBED_PROVIDER==='builtin'?CHUNKS:1;

// Warm-up, then steady state: nothing changed, so no note text may be read again.
store.loadWorkspaceEmbeddings(ws.id);store.pendingNoteEmbeddings(undefined,16);store.embeddingCoverage(ws.id);
const steady={load:reads(()=>store.loadWorkspaceEmbeddings(ws.id).length),all:reads(()=>store.loadAllEmbeddings().length),
  pending:reads(()=>store.pendingNoteEmbeddings(undefined,16).length),coverage:reads(()=>store.embeddingCoverage(ws.id).embedded)};

// One text edit, then 70 newer metadata-only edits: the text edit must still surface
// first (no starvation behind metadata churn) and only the touched notes are re-read.
const edited=ids[0]!;
updateNote({workspace_id:ws.id,agent_id:agent,is_admin:false,id:edited,text:'note 0 rewritten'});
const oneEdit=reads(()=>store.pendingNoteEmbeddings(undefined,16).map(n=>n.id));
for(const id of ids.slice(1,71))updateNote({workspace_id:ws.id,agent_id:agent,is_admin:false,id,metadata:{touched:true}});
const churn=reads(()=>store.pendingNoteEmbeddings(undefined,16).map(n=>n.id));
// A raw repair that clears text without bumping updated_at_ms (retention tombstones do this).
db.query("UPDATE notes SET text='' WHERE id=?").run(ids[1]!);
const loaded=new Set(store.loadWorkspaceEmbeddings(ws.id).map(r=>r.note_id));

let recallReads:number|null=null;
if(EMBED_PROVIDER!=='builtin'){
  const server=Bun.serve({port:0,fetch:()=>Response.json({embeddings:[Array(EMBED_DIM).fill(0.1)]})});
  process.env.QOOPIA_EMBED_ENDPOINT=`http://127.0.0.1:${server.port}/api/embed`;
  const p={workspace_id:ws.id,caller_agent_id:agent,is_admin:false,query:'zzqx unrelated',mode:'hybrid' as const,limit:5};
  await recall(p);const before=textRows;const hit=await recall(p);recallReads=textRows-before;
  if(hit.mode!=='hybrid')throw new Error('expected hybrid recall, got '+hit.mode);
  server.stop(true);
}
console.log(JSON.stringify({provider:EMBED_PROVIDER,n:N,per_note:perNote,steady,edited,one_edit:oneEdit,churn,
  loaded:{has_edited:loaded.has(edited),has_cleared:loaded.has(ids[1]!),has_untouched:loaded.has(ids[150]!),size:loaded.size},recall_text_rows:recallReads}));
closeDb();
