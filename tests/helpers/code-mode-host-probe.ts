// Subprocess for tests/tool-surface.test.ts, standing in for the server.
// `exit`: after runs that ended at the deadline and runs that ended in order, only the warm sandbox is left
// and process.exit still runs 'exit' listeners (the standalone service stops its tunnel child and releases
// its lock in them). `stuck`: prints the sandbox's pid while guest code holds it, then waits to be killed.
import fs from 'node:fs';
const {executeCode,codeHosts,CODE_LIMITS}=await import('../../src/mcp/code-mode.ts');
const none=async()=>null,native='return Array.prototype.indexOf.call({length:1e15},1)';
if(process.argv[2]==='stuck'){
  void executeCode(native,[],none,{...CODE_LIMITS,time_ms:1_000}).catch(()=>null);
  await Bun.sleep(500);
  console.log(JSON.stringify({hosts:codeHosts()}));
  await Bun.sleep(60_000);
}
process.once('exit',()=>fs.writeFileSync(process.argv[3]!,'yes'));
const quick={...CODE_LIMITS,time_ms:300};
const ended=await Promise.all([executeCode('for(;;){}',[],none,quick),executeCode(native,[],none,quick),
  executeCode('return 1',[],none),executeCode('return 2',[],none)].map(run=>run.then(out=>out.result,error=>error.message)));
for(let i=0;i<100&&codeHosts().length>1;i++)await Bun.sleep(20);
console.log(JSON.stringify({ended,hosts:codeHosts()}));
process.exit(0);
