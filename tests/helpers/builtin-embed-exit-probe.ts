// Subprocess for tests/builtin-embeddings.test.ts: after the built-in worker has run ONNX, the server's
// shutdown (stopBuiltinEmbeddings, then process.exit) must still run 'exit' listeners. The standalone
// service stops its tunnel child, releases its lock and closes its owner socket in them.
import fs from 'node:fs';
import path from 'node:path';
if(process.env.QOOPIA_EMBED_PROVIDER!=='builtin'||!process.env.QOOPIA_ROOT?.includes('qoopia-builtin-embed-'))
  throw new Error('Run through tests/builtin-embeddings.test.ts with an isolated root');
const {embedBuiltin,stopBuiltinEmbeddings}=await import('../../src/services/builtin-embeddings.ts');
const marker=path.join(process.env.QOOPIA_ROOT,'exit-listener-ran');
process.once('exit',()=>fs.writeFileSync(marker,'yes'));
await embedBuiltin('where is the deployment runbook',true);
console.log(JSON.stringify({embedded:true,marker}));
stopBuiltinEmbeddings();
setTimeout(()=>process.exit(0),100);
