import {beforeAll,expect,test} from 'bun:test';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {createNote,updateNote} from '../src/services/notes.ts';
import {upsertNoteEmbedding,pendingNoteEmbeddings,embeddingCoverage,loadWorkspaceEmbeddings} from '../src/services/embedding-store.ts';
import {EMBED_DIM} from '../src/services/embeddings.ts';
import {recall} from '../src/services/recall.ts';
import {envFlag} from '../src/utils/env.ts';
let workspace:string,agent:string;
beforeAll(()=>{runMigrations();const ws=createWorkspace({name:'Memory debts',slug:'memory-debts'});workspace=ws.id;agent=createAgent({name:'memory-debts-agent',workspaceSlug:ws.slug}).id;});
test('deployment boolean forms are accepted',()=>{expect(envFlag('1')).toBe(true);expect(envFlag('true')).toBe(true);expect(envFlag('false')).toBe(false);});
test('a late embedding cannot overwrite an edit; stale and deleted rows do not count as current',async()=>{
  let release!:(value:Response)=>void;
  const server=Bun.serve({port:0,fetch:()=>new Promise<Response>(r=>{release=r;})});
  const saved=process.env.QOOPIA_EMBED_ENDPOINT;process.env.QOOPIA_EMBED_ENDPOINT=`http://127.0.0.1:${server.port}/api/embed`;
  try {
    const note=createNote({workspace_id:workspace,agent_id:agent,text:'Первый вариант условия.'});
    const inFlight=upsertNoteEmbedding(note.id,workspace,'Первый вариант условия.');
    while(!release)await Bun.sleep(5);
    updateNote({workspace_id:workspace,agent_id:agent,is_admin:false,id:note.id,text:'Уточнённый вариант условия.'});
    release(Response.json({embeddings:[Array(EMBED_DIM).fill(0.1)]}));expect((await inFlight).embedded).toBe(false);
    expect(pendingNoteEmbeddings(workspace).some(n=>n.id===note.id)).toBe(true);
    server.reload({fetch:()=>Response.json({embeddings:[Array(EMBED_DIM).fill(0.1)]})});
    expect((await upsertNoteEmbedding(note.id,workspace,'Уточнённый вариант условия.')).embedded).toBe(true);
    expect(embeddingCoverage(workspace).embedded).toBe(1);
    updateNote({workspace_id:workspace,agent_id:agent,is_admin:false,id:note.id,text:'Третий вариант условия.'});
    expect(loadWorkspaceEmbeddings(workspace)).toHaveLength(0);expect(embeddingCoverage(workspace).embedded).toBe(0);
  } finally {server.stop(true);if(saved===undefined)delete process.env.QOOPIA_EMBED_ENDPOINT;else process.env.QOOPIA_EMBED_ENDPOINT=saved;}
});
test('FTS-only recall invokes an explicitly requested judge and rejects malformed rankings',async()=>{
  const one=createNote({workspace_id:workspace,agent_id:agent,text:'rerankdebtmark первый документ'});
  const two=createNote({workspace_id:workspace,agent_id:agent,text:'rerankdebtmark второй документ'});
  let calls=0;let malformed=false;
  const server=Bun.serve({port:0,async fetch(req){calls++;const body=await req.json() as {documents:string[]};return Response.json({results:malformed?[{index:0,score:1},{index:0,score:0}]:body.documents.map((d,i)=>({index:i,score:d.includes('второй')?1:0})).sort((a,b)=>b.score-a.score)});}});
  const saved=process.env.QOOPIA_RERANK_LLM_ENDPOINT;process.env.QOOPIA_RERANK_LLM_ENDPOINT=`http://127.0.0.1:${server.port}/rerank`;
  try {
    const p={workspace_id:workspace,caller_agent_id:agent,is_admin:false,query:'rerankdebtmark',mode:'fts5' as const,deep_llm:true};
    const result=await recall(p);expect(calls).toBe(1);expect(result.results[0]!.id).toBe(two.id);expect(result.judging.applied).toBe(true);
    malformed=true;const fallback=await recall(p);expect(fallback.results.map(r=>r.id).sort()).toEqual([one.id,two.id].sort());expect(fallback.judging.applied).toBe(false);
  } finally {server.stop(true);if(saved===undefined)delete process.env.QOOPIA_RERANK_LLM_ENDPOINT;else process.env.QOOPIA_RERANK_LLM_ENDPOINT=saved;}
});
