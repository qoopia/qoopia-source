import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {getV4FeatureFlags} from '../src/utils/health-metadata.ts';

/** Every relative markdown link in a tracked document resolves from the file that contains it.
 * Code spans and fenced blocks are examples, not links. Anchors are not checked. */
function brokenMarkdownLinks(root:string,files:string[]) {
  const broken:string[]=[];
  for(const file of files){
    const text=fs.readFileSync(path.join(root,file),'utf8').replace(/```[\s\S]*?```/g,'').replace(/`[^`\n]*`/g,'');
    for(const match of text.matchAll(/\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)){
      const target=decodeURIComponent(match[1]!.split('#')[0]!);
      if(!target||/^[a-z][a-z0-9+.-]*:/i.test(target)||target.startsWith('/'))continue;
      if(!fs.existsSync(path.resolve(path.dirname(path.join(root,file)),target)))broken.push(file+': '+match[1]);
    }
  }
  return broken;
}

test('relative markdown links in tracked documents resolve [F-249]',()=>{
  const root=path.resolve(import.meta.dir,'..');
  const listed=Bun.spawnSync(['git','ls-files','-z','*.md'],{cwd:root});
  expect(listed.exitCode).toBe(0);
  const files=listed.stdout.toString().split('\0').filter(file=>file&&!file.startsWith('audit/'));
  expect(files.length).toBeGreaterThan(50);
  expect(brokenMarkdownLinks(root,files)).toEqual([]);
  // The check itself: a link to a missing sibling fails, a ../ link to a real file passes.
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-docs-links-')),nested=path.join(scratch,'sub');
  try{
    fs.mkdirSync(nested);fs.writeFileSync(path.join(scratch,'real.md'),'# Real\n');
    fs.writeFileSync(path.join(nested,'NESTED.md'),'[up](../real.md#top) [gone](missing.md) `[code](absent.md)`\n');
    expect(brokenMarkdownLinks(scratch,['sub/NESTED.md'])).toEqual(['sub/NESTED.md: missing.md']);
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
});

// The public source export carries only some documents; an exported document that links to
// one it leaves out ships a dead link (and fails the test above in the public tree).
const exporter=path.resolve(import.meta.dir,'../scripts/export-public-source.ts');
test.skipIf(!fs.existsSync(exporter))('exported documents link only to exported files [F-334]',async()=>{
  const root=path.resolve(import.meta.dir,'..');
  const {selectExport}=await import(exporter);
  const tracked=Bun.spawnSync(['git','ls-files','-z'],{cwd:root}).stdout.toString().split('\0').filter(Boolean);
  const exported=new Set<string>(selectExport(tracked)),dead:string[]=[];
  for(const file of [...exported].filter(f=>f.endsWith('.md'))){
    const text=fs.readFileSync(path.join(root,file),'utf8').replace(/```[\s\S]*?```/g,'').replace(/`[^`\n]*`/g,'');
    for(const match of text.matchAll(/\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)){
      const target=decodeURIComponent(match[1]!.split('#')[0]!);
      if(!target||/^[a-z][a-z0-9+.-]*:/i.test(target)||target.startsWith('/'))continue;
      const resolved=path.relative(root,path.resolve(path.dirname(path.join(root,file)),target));
      if(tracked.includes(resolved)&&!exported.has(resolved))dead.push(file+': '+match[1]);
    }
  }
  expect(dead).toEqual([]);
});

// The index is private: the public source export carries only some operations documents and no index.
const operations=path.resolve(import.meta.dir,'../docs/operations');
test.skipIf(!fs.existsSync(path.join(operations,'README.md')))('the operations index links every operations document [F-248]',()=>{
  const dir=operations,index=fs.readFileSync(path.join(dir,'README.md'),'utf8');
  const linked=new Set([...index.matchAll(/\]\(([^)#\s]+)/g)].map(m=>m[1]));
  expect(fs.readdirSync(dir).filter(f=>f.endsWith('.md')&&f!=='README.md'&&!linked.has(f))).toEqual([]);
});

// Also private (not in the public source export).
const surfaces=path.join(operations,'surfaces-and-versions.md');
test.skipIf(!fs.existsSync(surfaces))('every live V4 feature flag is documented in surfaces-and-versions [F-251]',()=>{
  const text=fs.readFileSync(surfaces,'utf8');
  const flags=Object.keys(getV4FeatureFlags({})).map(key=>'QOOPIA_V4_'+key.toUpperCase());
  expect(flags.length).toBeGreaterThan(8);
  expect(flags.filter(flag=>!text.includes('`'+flag+'`'))).toEqual([]);
});
