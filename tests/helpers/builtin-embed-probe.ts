// Subprocess for tests/builtin-embeddings.test.ts. EMBED_PROVIDER is fixed at
// module load and tests/setup.ts pins the legacy provider, so the production
// default (built-in ONNX chunks) can only be exercised in a fresh process.
if(process.env.QOOPIA_EMBED_PROVIDER!=='builtin'||!process.env.QOOPIA_ROOT?.includes('qoopia-builtin-embed-'))
  throw new Error('Run through tests/builtin-embeddings.test.ts with an isolated root');
const {db,closeDb}=await import('../../src/db/connection.ts');
const {runMigrations}=await import('../../src/db/migrate.ts');runMigrations();
const {createWorkspace}=await import('../../src/admin/workspaces.ts'),{createAgent}=await import('../../src/admin/agents.ts');
const {createNote}=await import('../../src/services/notes.ts'),{recall}=await import('../../src/services/recall.ts');
const store=await import('../../src/services/embedding-store.ts');
const ws=createWorkspace({name:'Built-in embeddings',slug:'builtin-embeddings'}),agent=createAgent({name:'probe',workspaceSlug:ws.slug});
const backup='Резервная копия базы данных хранится на сервере Corsair.';
// ~1.9k chars of Russian exceeds 512 tokens per 1800-char window: covers token shrinking and overlap.
const recipe=Array.from({length:17},(_,i)=>`Шаг ${i+1}. Обжарьте лук и морковь в казане, добавьте баранину, зиру и промытый рис, затем томите плов под крышкой.`).join('\n');
const a=createNote({workspace_id:ws.id,agent_id:agent.id,text:backup}),b=createNote({workspace_id:ws.id,agent_id:agent.id,text:recipe});
const chunks=(id:string)=>db.query('SELECT start_char,end_char FROM note_embedding_chunks WHERE note_id=? ORDER BY chunk_no').all(id) as Array<{start_char:number;end_char:number}>;
const first=await store.upsertNoteEmbedding(a.id,ws.id,backup);
const again=await store.upsertNoteEmbedding(a.id,ws.id,backup);
const long=await store.upsertNoteEmbedding(b.id,ws.id,recipe);
// The live row already holds `backup`: an inference result for older text must be discarded.
const stale=await store.upsertNoteEmbedding(a.id,ws.id,'Старый текст заметки до правки');
const hit=await recall({workspace_id:ws.id,caller_agent_id:agent.id,is_admin:false,query:'where is the database backup kept',limit:5});
console.log(JSON.stringify({first,again,long,stale,ids:{backup:a.id,recipe:b.id},recipe_length:recipe.length,
  chunks:{backup:chunks(a.id),recipe:chunks(b.id)},workspace:store.loadWorkspaceEmbeddings(ws.id).length,all:store.loadAllEmbeddings().length,
  coverage:store.embeddingCoverage(ws.id),recall:{mode:hit.mode,ids:hit.results.map(r=>r.id)}}));
closeDb();
