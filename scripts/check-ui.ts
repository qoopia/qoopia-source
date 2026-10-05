/** Browser checks of the dashboard: an isolated synthetic preview plus the three Playwright checkers.
 * Needs a Playwright install with Chromium (it is not a dependency of this repository):
 *
 *   PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright bun run check:ui
 *
 * Writes screenshots and results to QOOPIA_PERF_OUTPUT (default ./work) and the preview directory.
 * No user data, no tunnel, no subscriptions: everything runs on loopback with synthetic fixtures. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';

const out=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-ui-check-')),preview=path.join(out,'preview');
// The preview gets a throw-away HOME too, so nothing in it can read or write the developer's own client configs.
const home=path.join(out,'home');fs.mkdirSync(home);
const server=Bun.spawn(['bun','scripts/dashboard-preview.ts','--out',preview],{stdout:'pipe',stderr:'inherit',env:{...process.env,HOME:home}});
let failed=false;
try {
  // The preview prints one JSON line once it listens and has written preview.json with a one-use login code.
  const reader=server.stdout.getReader();let text='';
  while(!text.includes('\n')){const {value,done}=await reader.read();if(done)throw Error('dashboard preview exited before it was ready');text+=new TextDecoder().decode(value);}
  for(const [script,args] of [['check-workflow-responsiveness',[]],['check-dashboard-responsiveness',[]],['check-dashboard-ui',[preview]]] as const){
    console.log('\n== '+script);
    const run=Bun.spawnSync(['node','scripts/'+script+'.cjs',...args],{stdout:'inherit',stderr:'inherit',env:process.env});
    if(run.exitCode!==0){failed=true;console.error(script+' failed');}
  }
} finally {server.kill();}
console.log('\nPreview data and screenshots: '+preview);
process.exit(failed?1:0);
