import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { Delivery, dataFile, readCurrent, operationsDirectory } from '../src/delivery/operations.ts';
import { hash, durableWrite, inventory } from '../src/delivery/files.ts';
import { verifyBundle } from '../src/delivery/bundle.ts';
import { verifyBackup, snapshotInfo } from '../src/delivery/snapshot.ts';
import { qoopiaSource, skillonomiaSource } from '../tests/helpers/source-fixtures.ts';
import { recordMaintenance, readOps, writeOps, opsPayload } from '../src/delivery/ops-state.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
const bundle=path.resolve(process.argv[process.argv.indexOf('--bundle')+1]!);
const trust=fs.readFileSync(path.join(bundle,'TEST-PUBLIC-KEY.pem'),'utf8');
const verified=verifyBundle(bundle,trust,true);
const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-p3-artifact-'))),root=path.join(outer,'Installed Ж space');
const events:unknown[]=[];
const run=(binary:string,args:string[],cwd=outer,expectedExit=0)=>{
 const started=Date.now();const result=spawnSync(binary,args,{cwd,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:outer,TMPDIR:outer},timeout:90000});
 events.push({argv:[binary,...args],exit_code:result.status,started_at:started,ended_at:Date.now(),stdout_sha256:hash(result.stdout??''),stderr:result.stderr});
 if(process.env.P3_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.P3_EVIDENCE_DIR,'artifact-subcommands.json'),JSON.stringify(events,null,2));
 assert.equal(result.status,expectedExit,JSON.stringify({command:args[0],stderr:result.stderr,doctor:args[0]==='doctor'?result.stdout:undefined}));return result.stdout.trim();
};
const migrate=(b:string,g:string)=>{run(path.join(b,'qoopia'),['_migrate','--root',g]);};
const d=new Delivery(root,trust,true,migrate);
try{
 // Engine integration only: sandbox forbids socket bind. A synthetic port does NOT qualify launcher preflight/start.
 const installed=d.install(bundle,43737);assert.equal(installed.port,43737);
 const dbfile=dataFile(root,installed),emptyDatabaseBytes=fs.statSync(dbfile).size,db=new Database(dbfile);const owner=bootstrapOwner(db,'Synthetic owner','Artifact fixture');
 db.query("INSERT INTO notes(id,workspace_id,agent_id,type,text) VALUES ('fixture-note',?,?,'memory','private synthetic canary')").run(owner.workspace_id,owner.agent_id);db.close();
 assert.equal(fs.statSync(dbfile).mode&0o777,0o600,'Standalone database must be private at creation');
 const binary=path.join(root,'bundles',installed.bundle,'qoopia');
 const maintenance=JSON.parse(run(binary,['maintenance','--root',root,'--commit','--allow-test-fixture']));assert.equal(maintenance.ok,true);assert.equal(maintenance.report.backup.unified_restore,true);assert.equal(maintenance.report.application_logs.days,14);assert(fs.existsSync(path.join(root,'operations','operations-status.json')));assert(fs.existsSync(path.join(root,'logs','application','ownership.json')));
 const scheduledFolder=path.join(root,'backups');const scheduled=fs.readdirSync(scheduledFolder).filter(n=>n.endsWith('.backup'));assert.equal(scheduled.length,1);assert.equal(verifyBackup(path.join(scheduledFolder,scheduled[0]!)).instance,installed.instance);
 const backup=path.join(outer,'backup');run(binary,['backup','--root',root,'--out',backup,'--commit','--allow-test-fixture']);
 const doctor=JSON.parse(run(binary,['doctor','--root',root,'--allow-test-fixture']));assert.equal(doctor.ok,true);assert(!JSON.stringify(doctor).includes('private synthetic canary'));
 const support=JSON.parse(run(binary,['support-preview','--root',root,'--allow-test-fixture']));assert.equal(support.preview,true);assert.equal(support.automatic_send,false);assert(support.events.length>0);assert(!JSON.stringify(support).includes('private synthetic canary'));
 // Hostile cwd config must not change the compiled entry's behavior.
 fs.writeFileSync(path.join(outer,'.env'),'QOOPIA_ROOT=/forbidden\nQOOPIA_SERVER_ROLE=legacy-readonly\n');
 fs.writeFileSync(path.join(outer,'bunfig.toml'),'preload = ["/forbidden"]\n');
 assert.equal(JSON.parse(run(binary,['doctor','--root',root,'--allow-test-fixture'])).ok,true);
 const bytesBefore=fs.readFileSync(dbfile);
 const updatePlan=JSON.parse(run(binary,['update','--root',root,'--bundle',bundle,'--allow-test-fixture'])),updatePlanFile=path.join(outer,'update-plan.json');
 durableWrite(updatePlanFile,JSON.stringify(updatePlan));
 run(binary,['update','--root',root,'--bundle',bundle,'--plan',updatePlanFile,'--approve',updatePlan.plan_digest,'--commit','--allow-test-fixture']);
 run(binary,['rollback','--root',root,'--commit','--allow-test-fixture']);assert.deepEqual(fs.readFileSync(dbfile),bytesBefore);
 // New OS-user simulation uses a separate root; this is not an actual fresh OS account.
 const restoredRoot=path.join(outer,'Restored Ж new user');
 const restored=new Delivery(restoredRoot,trust,true,migrate).restoreNew(backup,bundle,43738);
 const fresh=new Database(dataFile(restoredRoot,restored.current),{readonly:true});
 assert.equal((fresh.query("SELECT text FROM notes WHERE id='fixture-note'").get() as {text:string}).text,'private synthetic canary');
 assert.notEqual((fresh.query('SELECT api_key_hash FROM agents WHERE id=?').get(owner.agent_id) as {api_key_hash:string}).api_key_hash,hash(owner.api_key));fresh.close();
 // Seed explicit receipt fixtures (not receiver evidence), then exercise compiled recovery callers.
 const recoveredOps=operationsDirectory(restoredRoot,restored.current);
 recordMaintenance(recoveredOps,installed.instance,'BACKUP_FAILED',1000);
 const seeded=readOps(recoveredOps),alert=seeded.alerts[0]!;
 alert.state='confirmed';alert.attempts=1;alert.last_error=null;
 alert.receipt={event_id:alert.id,accepted:true,payload_sha256:hash(JSON.stringify({id:alert.id,event_type:'operational_alert',payload:opsPayload(alert)}))};
 writeOps(recoveredOps,seeded);recordMaintenance(recoveredOps,installed.instance,null,1001);
 recordMaintenance(recoveredOps,installed.instance,'BACKUP_FAILED',1002);recordMaintenance(recoveredOps,installed.instance,null,1003);
 const savedOps=readOps(recoveredOps),portable=path.join(outer,'portable-ops');
 run(binary,['backup','--root',restoredRoot,'--out',portable,'--commit','--allow-test-fixture']);
 assert.equal(verifyBackup(portable).format,'qoopia-backup/2');
 run(binary,['restore','--root',restoredRoot,'--backup',portable,'--commit','--allow-test-fixture']);
 const selectedOps=operationsDirectory(restoredRoot,readCurrent(restoredRoot));assert.deepEqual(readOps(selectedOps),savedOps);
 const recoveredMaintenance=JSON.parse(run(binary,['maintenance','--root',restoredRoot,'--commit','--allow-test-fixture']));
 assert.equal(recoveredMaintenance.report.operations.pending,1);assert.deepEqual(readOps(selectedOps).alerts,savedOps.alerts);
 const recoveredDoctor=JSON.parse(run(binary,['doctor','--root',restoredRoot,'--allow-test-fixture'],outer,1));
 assert.equal(recoveredDoctor.checks.maintenance.pending,1);assert.equal(recoveredDoctor.checks.backup.status,'pass');
 assert(!fs.existsSync(path.join(restoredRoot,'ops-channels.json')));
 // Four source journeys use exactly the accepted source fixtures and the compiled source adapter.
 const journeys:unknown[]=[];
 for(const sources of [[],[qoopiaSource(32)],[qoopiaSource(35)],[skillonomiaSource()],[qoopiaSource(35),skillonomiaSource()]]) {
   const journeyRoot=path.join(outer,'journey-'+journeys.length), engine=new Delivery(journeyRoot,trust,true,migrate);
   const initial=engine.install(bundle,45000+journeys.length), live=new Database(dataFile(journeyRoot,initial));
   const human=bootstrapOwner(live,'Journey owner','Journey workspace');live.close();const reports:unknown[]=[];
   for(const source of sources){
     const input=path.join(outer,'source-'+journeys.length+'-'+source.origin+'.db');durableWrite(input,source.bytes);const beforeHash=hash(fs.readFileSync(input));
     const mapFile=input+'.map.json';durableWrite(mapFile,JSON.stringify({'01AAAAAAAAAAAAAAAAAAAAAAAA':human.workspace_id}));
     const extra:string[]=[];
     if(source.blobs){const refs:Record<string,string>={};for(const [ref,bytes] of source.blobs){const filename=input+'.'+hash(ref);durableWrite(filename,bytes);refs[ref]=filename;}durableWrite(input+'.blobs.json',JSON.stringify(refs));extra.push('--blobs',input+'.blobs.json');}
     const executable=path.join(journeyRoot,'bundles',initial.bundle,'qoopia');
     const common=['--root',journeyRoot,'--source',input,'--kind',source.kind,'--origin',source.origin,...extra];
     const plan=JSON.parse(run(executable,['source-plan',...common]));
     const beforeImport=snapshotInfo(dataFile(journeyRoot,readCurrent(journeyRoot))).logical_hash;
     const pointerBefore=fs.readFileSync(path.join(journeyRoot,'current.json'));
     run(executable,['migrate-source',...common,'--expected-digest','0'.repeat(64),'--workspace-map',mapFile,'--commit','--allow-test-fixture'],outer,1);
     assert.deepEqual(fs.readFileSync(path.join(journeyRoot,'current.json')),pointerBefore);
     const applied=JSON.parse(run(executable,['migrate-source',...common,'--expected-digest',plan.source_digest,'--workspace-map',mapFile,'--commit','--allow-test-fixture']));
     assert.equal(applied.report.mapping_coverage,1);assert.equal(hash(fs.readFileSync(input)),beforeHash);
     const counts=applied.report.mapped_rows;
     run(executable,['rollback','--root',journeyRoot,'--commit','--allow-test-fixture']);
     assert.equal(snapshotInfo(dataFile(journeyRoot,readCurrent(journeyRoot))).logical_hash,beforeImport);
     run(executable,['migrate-source',...common,'--expected-digest',plan.source_digest,'--workspace-map',mapFile,'--commit','--allow-test-fixture']);
     const replay=JSON.parse(run(executable,['migrate-source',...common,'--expected-digest',plan.source_digest,'--workspace-map',mapFile,'--commit','--allow-test-fixture']));assert.equal(replay.report.mapped_rows,counts);
     reports.push({kind:source.kind,source_schema:plan.source_schema,source_digest:plan.source_digest,mapped_rows:counts,mapping_coverage:1,source_unchanged:true,import_rollback_verified:true,stale_digest_refused:true});
   }
   const final=readCurrent(journeyRoot),journeyBackup=path.join(outer,'journey-backup-'+journeys.length);engine.backup(journeyBackup);assert.equal(engine.doctor().ok,true);
   journeys.push({sources:sources.map(x=>x.origin),reports,backup_verified:true,instance:final.instance});
 }
 // Minimal real PDF and DOCX generated in memory; parser execution occurs inside exact compiled artifact.
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const content='BT /F1 12 Tf 20 100 Td (Qoopia fixture PDF) Tj ET';objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
 let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 const pdfFile=path.join(outer,'fixture.pdf');fs.writeFileSync(pdfFile,pdf);
 const p=JSON.parse(run(binary,['parser-smoke','--root',root,'--allow-test-fixture','--file',pdfFile,'--mime','application/pdf']));assert.equal(p.status,'extracted');assert.match(p.text,/Qoopia fixture PDF/);
 const JSZip=(await import('jszip')).default;const zip=new JSZip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Qoopia fixture DOCX</w:t></w:r></w:p></w:body></w:document>');
 const doc=path.join(outer,'fixture.docx');fs.writeFileSync(doc,await zip.generateAsync({type:'nodebuffer'}));
 const parsed=JSON.parse(run(binary,['parser-smoke','--root',root,'--allow-test-fixture','--file',doc,'--mime','application/vnd.openxmlformats-officedocument.wordprocessingml.document']));assert.equal(parsed.status,'extracted');assert.match(parsed.text,/Qoopia fixture DOCX/);
 const before=inventory(root);assert.equal(d.doctor().ok,true);assert.deepEqual(inventory(root),before);
 durableWrite(path.join(root,'manual-skill.md'),'manual bytes');d.uninstall();assert(fs.existsSync(dbfile));assert.equal(fs.readFileSync(path.join(root,'manual-skill.md'),'utf8'),'manual bytes');
 console.log(JSON.stringify({status:'PASS_LOCAL_ARTIFACT_ENGINE',journeys,bundle_manifest:verified.digest,platform:`${process.platform}-${process.arch}`,native_models_invoked:0,launcher_port:'BLOCKED: sandbox bind EPERM; synthetic engine port only',new_os_user:'SIMULATED_ROOT_ONLY',empty_database_bytes:emptyDatabaseBytes,scheduled_backup_restore_verified:true,portable_operations_restore_verified:true,installed_bundle_bytes:Object.values(verified.manifest.members).reduce((n,r)=>n+r.size,0),events},null,2));
}finally{fs.rmSync(outer,{recursive:true,force:true});}
