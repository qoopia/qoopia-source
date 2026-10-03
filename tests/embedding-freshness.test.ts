import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// F-079/F-080: embedding freshness must not re-read and re-hash the corpus on
// every recall or 5 s maintenance tick; only edited notes are read again.
for(const provider of ['builtin','ollama'])test(`${provider}: steady-state embedding reads do not load note text`,()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-embed-freshness-')));
  try {
    const run=spawnSync(process.execPath,[path.join(import.meta.dir,'helpers','embedding-freshness-probe.ts')],{encoding:'utf8',timeout:55_000,
      env:{PATH:process.env.PATH,HOME:root,TMPDIR:root,QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),
        QOOPIA_BACKUP_DIR:path.join(root,'backups'),QOOPIA_LOG_LEVEL:'error',QOOPIA_SERVER_ROLE:'canonical',QOOPIA_PORT:'0',
        QOOPIA_AUTO_EMBED:'false',QOOPIA_EMBED_PROVIDER:provider}});
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const r=JSON.parse(run.stdout);
    expect(r.provider).toBe(provider);
    expect(r.steady).toEqual({load:{value:r.n*r.per_note,text_rows:0},all:{value:r.n*r.per_note,text_rows:0},
      pending:{value:0,text_rows:0},coverage:{value:r.n,text_rows:0}});
    expect(r.one_edit.value).toEqual([r.edited]);
    expect(r.one_edit.text_rows).toBeLessThanOrEqual(2);
    expect(r.churn.value).toEqual([r.edited]);
    expect(r.churn.text_rows).toBeLessThanOrEqual(72);
    expect(r.loaded).toEqual({has_edited:false,has_cleared:false,has_untouched:true,size:r.n-2});
    // Eligibility for the vector channel must not hydrate every embedded note.
    if(provider==='ollama')expect(r.recall_text_rows).toBeLessThan(r.n/2);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
},60_000);
