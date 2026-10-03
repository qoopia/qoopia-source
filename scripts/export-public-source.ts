#!/usr/bin/env bun
/**
 * Public source export (qoopia/qoopia-source), fail-closed.
 *
 *   bun scripts/export-public-source.ts --plan [--ref REF]
 *   bun scripts/export-public-source.ts --public <clean qoopia-source checkout> [--ref REF]
 *
 * An allowlist selects canonical files, read from Git at REF (never the working
 * tree). Public-maintained files (contributor docs, public CI, fixtures, release
 * identity) are carried from the public checkout's HEAD. Every exported text file
 * is scanned for private markers before anything is written; any hit refuses.
 * The export rewrites the checkout's working tree (deletions included) and its
 * SOURCE-MANIFEST.json. It never commits, pushes or touches a remote.
 * Procedure: docs/operations/public-source-distribution.md.
 *
 * This file is itself published: it carries patterns and hashes, never the
 * private values it looks for.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {PUBLIC_SOURCE_EXCLUSIONS} from './bundle-signing.ts';

const EXPORT_DIRS=['.github/','benchmarks/','docs/v4/','ios/','marketing-site/','migrations/','scripts/','sdk/','src/','templates/','tests/'];
const EXPORT_FILES=new Set(['.dockerignore','DESIGN.md','Dockerfile','LICENSE','bun.lock','bunfig.toml','package.json','tsconfig.json',
 'deploy/docker-compose.release.yml','deploy/fleet-tools-contract.json','deploy/identity.Dockerfile','deploy/release-operator.env.example',
 'docs/10-as-is/README.md','docs/20-to-be/README.md','docs/30-migration/README.md','docs/BRIDGES.md','docs/INTERFACE-LANGUAGES.md',
 'docs/MEMORY-V1.md','docs/P1-AUTHORITY.md','docs/P2-LOOP.md','docs/P3-CONTRACT.md','docs/analytics/README.md','docs/v1-setup.md',
 'docs/discovery/CLAIM-POLICY.md','docs/discovery/UNDERSTAND-EN.md','docs/discovery/UNDERSTAND-RU.md','docs/discovery/answers.json','docs/discovery/prompts.json',
 'docs/operations/agent-kit-refresh.md','docs/operations/connections.md','docs/operations/ios-direct-dashboard.md','docs/operations/my-qoopia-agent.md',
 'docs/operations/news-and-owner.md','docs/operations/operational-normalization.md','docs/operations/release-consistency.md',
 'docs/operations/storage-full-check.md','docs/operations/telegram-subscription-runtime.md','docs/operations/unified-release-503-20260915.md']);
// Adapted or public-only: never copied from canonical. Port canonical changes into them by a reviewed public PR.
const PUBLIC_MAINTAINED=['.github/workflows/ci.yml','.gitignore','AGENTS.md','CHANGELOG.md','CLAUDE.md','CONTRIBUTING.md',
 'README.md','README.ru.md','RELEASE.json','SECURITY.md','compose/docker-compose.v4.yml','docs/CANONICAL-DESIGN.md','docs/SOURCE-PROVENANCE.md',
 'docs/operations/agent-memory-policy.md','scripts/analytics-providers.py','scripts/public-source-exclusions.json',
 'tests/fixtures/schema35-source.json','tests/fixtures/schema35-source.tar.gz','tests/p1-owner-upgrade.test.ts','examples/','release-evidence/'];
const RUNTIME_ROOTS=['src/','migrations/','templates/','sdk/'];
const MANIFEST='SOURCE-MANIFEST.json',UNHASHED=new Set([MANIFEST,'docs/SOURCE-PROVENANCE.md']);

const publicMaintained=(p:string)=>PUBLIC_MAINTAINED.some(m=>m.endsWith('/')?p.startsWith(m):p===m);
export function selectExport(paths:string[]){
 const excluded=new Set(PUBLIC_SOURCE_EXCLUSIONS);
 return paths.filter(p=>!excluded.has(p)&&!publicMaintained(p)&&(EXPORT_FILES.has(p)||EXPORT_DIRS.some(d=>p.startsWith(d)))).sort();
}

// sha256 prefixes of known private identifiers (production workspace, archived production notes).
const PRIVATE_IDS=new Set(['0a6e3eb9771cf8a7d33917a4','aa7c53bcec81bcb4ca2fd746','79ab966d1b82473ddaa55caf','34440b14c72ac71a262c32d0',
 '1d314713a0e11ef1230390c6','c24dc3a4c1b9c1fd7aea2fbf','5394e9108e530236c2d8bcfa','8001a3d59b8b50d25de8bf9f','672365223567d08cfbd98151',
 'ff12569f1104510595464c16','6aad2e2b43454921cf6f6e0d','fe4a7441b761387ae743df2f','f7a6c277882b1d9599fa0d64','8dd91468a0b4e8c4d8d1470e',
 '3a42f8f58991d434646ab364','80a398907734039f7e1ae6fb','19b962e2a0c97e8fa8f01537','de7740efd7ca8e3257dc422a','fcd30fad9108bcb10cf6a59f',
 '365f0cf82ddc934b4f13795b','d5a1079826809229075b7047','b9f37ca21a9b81e8962df873']);
const RULES:[string,RegExp][]=[
 ['home-path',/\/Users\/(?!(?:Shared|example|owner|test|user|you|runner|harmless)\b)[A-Za-z0-9._-]+|\/home\/(?!(?:example|owner|test|user|you|runner|harmless|node|bun)\b)[a-z_][a-z0-9_-]*\//],
 ['tailnet-ip',/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
 ['ssh-target',/\b[a-z_][a-z0-9_-]*@(?:\d{1,3}\.){3}\d{1,3}\b/],
 ['agent-home',/\.ductor-[a-z]/],
 ['local-hostname',/@[A-Za-z0-9-]+\.local\b/],
 ['private-key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
 ['token',/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/],
];
const EMAIL=/(?<![\\\w.%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;
const PUBLIC_EMAIL_DOMAIN=/(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com|qoopia\.ai|github\.com|claude\.ai)$/i;
// Reviewed exceptions: path (or directory prefix) -> marker kinds that are expected there.
// ponytail: whole-file scope; a real secret added to these files is left to GitHub push protection.
const REVIEWED:[string,string[]][]=[
 ['scripts/vendor/licenses/',['email']], // third-party attribution notices
 ['tests/secret-guard.test.ts',['token','private-key']], // synthetic detector samples
 ['tests/secret-guard-vn1-forms.test.ts',['token']],
 ['tests/skills.test.ts',['token']],
 ['migrations/004_claude_code_agents.sql',['home-path']], // applied migration: immutable, already public
 ['tests/helpers/agent-install-browser.py',['home-path']], // negative assertion
 ['src/services/event-outbox.ts',['tailnet-ip']], // RFC 6598 range in the outbox address blocklist
 ['tests/security-v4.test.ts',['tailnet-ip']], // addresses the outbox blocklist must refuse
 ['tests/log-sanitize.test.ts',['private-key']], // synthetic redaction sample
];

export type Hit={path:string,line:number,kind:string};
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
export function scanText(file:string,text:string):Hit[]{
 const allowed=new Set(REVIEWED.filter(([p])=>p.endsWith('/')?file.startsWith(p):file===p).flatMap(([,kinds])=>kinds)),hits:Hit[]=[];
 text.split('\n').forEach((line,i)=>{
  const kinds=RULES.filter(([,rx])=>rx.test(line)).map(([kind])=>kind);
  for(const m of line.matchAll(EMAIL))if(!PUBLIC_EMAIL_DOMAIN.test(m[1]!))kinds.push('email');
  for(const m of line.matchAll(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g))if(PRIVATE_IDS.has(digest(m[0]).slice(0,24)))kinds.push('private-id');
  for(const kind of new Set(kinds))if(!allowed.has(kind))hits.push({path:file,line:i+1,kind});
 });
 return hits;
}
const isText=(bytes:Buffer)=>!bytes.subarray(0,8000).includes(0);
export function scanTree(tree:Map<string,Blob>){return [...tree].flatMap(([p,b])=>isText(b.bytes)?scanText(p,b.bytes.toString('utf8')):[]);}

type Blob={mode:string,bytes:Buffer};
function git(cwd:string,args:string[],input?:string){
 const run=spawnSync('git',args,{cwd,input,maxBuffer:1024*1024*1024});
 if(run.status!==0)throw new Error(`git ${args[0]} failed: ${run.stderr.toString().trim()}`);
 return run.stdout as Buffer;
}
/** Every regular file at REF, read from the object store in one batch. */
export function readTree(cwd:string,ref:string){
 const entries=git(cwd,['ls-tree','-r','-z','--full-tree',ref]).toString('utf8').split('\0').filter(Boolean).map(e=>{
  const [meta,file]=e.split('\t') as [string,string];const [mode,type,id]=meta.split(' ') as [string,string,string];
  if(type!=='blob'||!['100644','100755'].includes(mode))throw new Error(`Export refuses non-regular entry: ${file}`);
  return {file,mode,id};
 });
 const out=git(cwd,['cat-file','--batch'],entries.map(e=>e.id).join('\n')+'\n'),tree=new Map<string,Blob>();let at=0;
 for(const e of entries){
  const nl=out.indexOf(10,at),size=Number(out.subarray(at,nl).toString().split(' ')[2]);
  tree.set(e.file,{mode:e.mode,bytes:Buffer.from(out.subarray(nl+1,nl+1+size))});at=nl+1+size+1;
 }
 return tree;
}

function exportTree(repo:string,ref:string,publicDir:string){
 if(git(publicDir,['status','--porcelain=v1','--untracked-files=all']).length)throw new Error('Public checkout must be clean');
 // Public commits made from this checkout must not expose a personal email or the host's fallback identity.
 for(const ident of ['GIT_AUTHOR_IDENT','GIT_COMMITTER_IDENT'])if(!/@users\.noreply\.github\.com> /.test(git(publicDir,['var',ident]).toString()))
  throw new Error('Public checkout must commit as the GitHub noreply identity (git config user.email <id>+<login>@users.noreply.github.com; user.useConfigOnly true)');
 const canonical=readTree(repo,ref),published=readTree(publicDir,'HEAD'),tree=new Map<string,Blob>();
 for(const p of selectExport([...canonical.keys()]))tree.set(p,canonical.get(p)!);
 for(const [p,b] of published)if(publicMaintained(p))tree.set(p,b);
 const hits=scanTree(tree);if(hits.length)return {status:'REFUSED_PRIVATE_MARKERS',hits};
 for(const root of RUNTIME_ROOTS){
  const a=[...canonical.keys()].filter(p=>p.startsWith(root)),b=[...tree.keys()].filter(p=>p.startsWith(root));
  if(a.length!==b.length||a.some(p=>!tree.get(p)?.bytes.equals(canonical.get(p)!.bytes)))throw new Error(`Runtime root ${root} is not byte-identical to ${ref}`);
 }
 const removed=[...published.keys()].filter(p=>!tree.has(p)&&p!==MANIFEST);
 for(const p of removed)fs.rmSync(path.join(publicDir,p));
 for(const [p,b] of tree){const file=path.join(publicDir,p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b.bytes);fs.chmodSync(file,b.mode==='100755'?0o755:0o644);}
 const files=[...tree.keys()].filter(p=>!UNHASHED.has(p)).sort().map(p=>{const b=tree.get(p)!.bytes;
  return {path:p,sha256:digest(b),bytes:b.length,source_snapshot_identical:!!canonical.get(p)?.bytes.equals(b)};});
 const snapshot=git(repo,['rev-parse',ref]).toString().trim(),version=JSON.parse(canonical.get('package.json')!.bytes.toString()).version;
 fs.writeFileSync(path.join(publicDir,MANIFEST),JSON.stringify({format:'qoopia-public-source/1',source_snapshot:snapshot,product_version:version,runtime_files_identical:true,files},null,2)+'\n');
 return {status:'EXPORTED',source_snapshot:snapshot,files:tree.size,removed,
  next:'Review git status/diff in the public checkout, commit with the noreply identity, open a PR (docs/operations/public-source-distribution.md).'};
}

if(import.meta.main){
 const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
 const ref=value('--ref')??'HEAD',repo=process.cwd(),publicDir=value('--public');
 let result:{status:string,hits?:Hit[]}&Record<string,unknown>;
 if(args.includes('--plan')){
  const canonical=readTree(repo,ref),files=selectExport([...canonical.keys()]);
  const hits=scanTree(new Map(files.map(p=>[p,canonical.get(p)!])));
  result={status:hits.length?'REFUSED_PRIVATE_MARKERS':'PLAN_OK',ref,files,
   public_maintained_in_canonical:[...canonical.keys()].filter(publicMaintained),hits};
 }else if(publicDir&&path.isAbsolute(publicDir))result=exportTree(repo,ref,publicDir);
 else throw new Error('Use --plan, or --public <absolute path of a clean public checkout>');
 console.log(JSON.stringify(result,null,2));
 if(result.hits?.length)process.exit(1);
}
