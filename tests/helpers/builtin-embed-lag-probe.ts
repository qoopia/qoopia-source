// Subprocess for tests/builtin-embeddings.test.ts: real built-in model, measures how
// long the event loop stalls from the cold start (no warm-up: the first recall after
// a restart loads the tokenizer and the model, F-307) through several passages.
if(process.env.QOOPIA_EMBED_PROVIDER!=='builtin'||!process.env.QOOPIA_ROOT?.includes('qoopia-builtin-embed-'))
  throw new Error('Run through tests/builtin-embeddings.test.ts with an isolated root');
const {embedBuiltin}=await import('../../src/services/builtin-embeddings.ts');
const server=Bun.serve({port:0,fetch:()=>new Response('ok')});
const prose=Array.from({length:100},(_,i)=>`Sentence ${i} about the project plan and memory.`).join(' ');
let maxGap=0,last=performance.now(),maxHealth=0,done=false;
const tick=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;},5);
const health=(async()=>{while(!done){const started=performance.now();await fetch(new URL('/health',server.url));maxHealth=Math.max(maxHealth,performance.now()-started);await Bun.sleep(20);}})();
const started=performance.now();
const cold=await embedBuiltin('where is the deployment runbook',true);
const coldMs=performance.now()-started;
const results=[cold,...await Promise.all([embedBuiltin(prose),embedBuiltin(prose),embedBuiltin('where is the plan',true)])];
const total=performance.now()-started;
done=true;maxGap=Math.max(maxGap,performance.now()-last);clearInterval(tick);await health;server.stop(true);
console.log(JSON.stringify({passages:results.reduce((n,r)=>n+r.length,0),cold_ms:Math.round(coldMs),total_ms:Math.round(total),
  max_gap_ms:Math.round(maxGap),max_health_ms:Math.round(maxHealth),main_heap_mb:Math.round(process.memoryUsage().heapUsed/1e6)}));
