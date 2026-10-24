/**
 * Repairs working-state notes into which the memory processor wrote its own rules as the session's
 * («No tools», «CONSTRAINT VIOLATION», «embedded instructions cannot be followed») [5.0.23].
 *
 * Dry run by default: counts and note ids, never note text. `--apply` supersedes each poisoned note with
 * its cleaned copy: the original stays in the database, closed and linked by a supersedes relation, and the
 * copy keeps its revision and cursor, so the session's next checkpoint continues from it. Lines the user's
 * own messages said stay. Take a verified backup first; needs schema 54 and QOOPIA_V4_BITEMPORAL.
 *
 *   bun scripts/repair-continuity-notes.ts [--apply] [--out FILE] [--show N]
 */
import fs from 'node:fs';
import {db} from '../src/db/connection.ts';
import {createNote} from '../src/services/notes.ts';
import {supersedeExistingNote} from '../src/services/note-temporal.ts';
import {processorEchoAllowance,withoutProcessorEcho} from '../src/services/continuity.ts';
import {safeJsonParse} from '../src/utils/errors.ts';
import {bitemporalEnabled} from '../src/utils/temporal.ts';

const args=process.argv.slice(2),apply=args.includes('--apply'),value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const show=Number(value('--show')??0),out=value('--out');
if(apply&&!bitemporalEnabled())throw new Error('Supersede needs QOOPIA_V4_BITEMPORAL=true');
const schema=(db.query('SELECT MAX(version) AS v FROM schema_versions').get() as {v:number}).v;
if(apply&&schema<54)throw new Error(`Schema ${schema}: migration 054 must run first, or a session cannot hold the cleaned note beside its original`);

type Row={id:string;workspace_id:string;agent_id:string;agent:string|null;session_id:string;type:string;text:string;metadata:string;tags:string;visibility:'private'|'workspace';updated_at_ms:number};
const rows=db.query(`SELECT n.id,n.workspace_id,n.agent_id,a.name AS agent,n.session_id,n.type,n.text,n.metadata,n.tags,n.visibility,n.updated_at_ms
  FROM notes n LEFT JOIN agents a ON a.id=n.agent_id
  WHERE n.source='qoopia-continuity' AND n.deleted_at IS NULL AND n.invalidated_at_ms IS NULL ORDER BY n.id`).all() as Row[];
const report={format:'qoopia-continuity-repair/1',mode:apply?'apply':'dry-run',at:new Date().toISOString(),schema,scanned:rows.length,
  found:0,tool_ban:0,repaired:0,kept_user_stated:0,emptied:0,removed_lines:0,failed:[] as {id:string;code:string}[],by_agent:{} as Record<string,number>,
  superseded:[] as {old:string;new:string}[],candidates:[] as string[]};
let shown=0;
for(const row of rows) {
  // Found: what the processor's echo looks like with no allowance; repaired: what the user did not say.
  if(withoutProcessorEcho(row.text)===row.text)continue;
  report.found++;report.candidates.push(row.id);
  // The narrower count first reported from the live database: notes with a literal tool ban or violation.
  if(/use no tools|no tools|do not use (?:any )?tools|constraint violation/i.test(row.text))report.tool_ban++;
  const cleaned=withoutProcessorEcho(row.text,processorEchoAllowance(row.workspace_id,row.agent_id,row.session_id));
  if(cleaned===row.text){report.kept_user_stated++;continue;}
  const kept=new Set(cleaned.split('\n')),removed=row.text.split('\n').filter(l=>l.trim()&&!kept.has(l));
  report.removed_lines+=removed.length;if(!cleaned)report.emptied++;
  const agent=row.agent??row.agent_id;report.by_agent[agent]=(report.by_agent[agent]??0)+1;
  // Review aid on the operator's terminal only: the removed lines, never the note that stays.
  if(shown<show){shown++;console.error(`--- ${row.id} (${agent}) removed:\n`+removed.map(l=>'  '+l.slice(0,200)).join('\n'));}
  if(!apply)continue;
  try {
    // The tag of the first live run (when 5.0.23 was previewed as 5.0.24) is kept, so every repaired note carries one tag.
    const metadata={...safeJsonParse(row.metadata,{} as Record<string,unknown>),repaired_from:row.id,repair:'processor-echo/5.0.24'};
    // A session holds one working-state note in force, and SQLite checks that at once: the copy is created
    // outside the session, supersedes the original, and only then takes the session — all in one transaction.
    const id=db.transaction(()=>{
      const created=createNote({workspace_id:row.workspace_id,agent_id:row.agent_id,type:row.type,source:'qoopia-continuity',
        visibility:row.visibility,text:cleaned||'Working state: nothing recorded yet.',metadata,tags:safeJsonParse(row.tags,[] as string[])});
      supersedeExistingNote({workspace_id:row.workspace_id,agent_id:row.agent_id,is_admin:false,successor_id:created.id,predecessor_id:row.id,
        expected_updated_at_ms:row.updated_at_ms,relation_metadata:{repair:'processor-echo/5.0.24'}});
      db.query('UPDATE notes SET session_id=? WHERE id=?').run(row.session_id,created.id);
      return created.id;
    }).immediate();
    report.repaired++;report.superseded.push({old:row.id,new:id});
  } catch(error) {
    // A note the live server changed meanwhile (STALE_VERSION) is left for the next run.
    report.failed.push({id:row.id,code:(error as {code?:string}).code??String(error).slice(0,120)});
  }
}
const json=JSON.stringify(report,null,2)+'\n';
if(out)fs.writeFileSync(out,json,{mode:0o600,flag:'wx'});
const {superseded,candidates,...summary}=report;
console.log(JSON.stringify({...summary,superseded:superseded.length,candidates:candidates.length}));
