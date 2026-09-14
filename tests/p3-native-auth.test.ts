import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { claudeAuthMode, bindAuthSelector, claudeEnvironment } from '../scripts/p3-native-auth.ts';

test('Installed controller Claude selector is explicit, immutable and uses existing env validation without native probes',()=>{
  expect(claudeAuthMode('subscription',undefined,true)).toBe('subscription');
  expect(claudeAuthMode(undefined,'/synthetic/config-dir',true)).toBe('subscription-store');
  expect(claudeAuthMode('subscription-store','/synthetic/config-dir',true)).toBe('subscription-store');
  expect(claudeAuthMode('subscription',undefined,false)).toBe('subscription');
  for(const mode of ['automatic','api-key','default-keychain','config-dir',''])expect(()=>claudeAuthMode(mode,undefined,true)).toThrow();
  expect(()=>claudeAuthMode(undefined,undefined,true)).toThrow('config-dir');
  expect(()=>claudeAuthMode('subscription','/synthetic/store',true)).toThrow('cannot select');
  expect(()=>claudeAuthMode('subscription-store','/synthetic/store',false)).toThrow('No real stores');
  const selection={claude_code:{auth_mode:'subscription'},codex:{auth_mode:'subscription-store',login_store:'/synthetic/codex'}};
  expect(()=>bindAuthSelector(selection,structuredClone(selection))).not.toThrow();
  expect(()=>bindAuthSelector(selection,{...selection,claude_code:{auth_mode:'subscription-store'}})).toThrow('resume refused');
  expect(()=>bindAuthSelector(selection,{...selection,codex:{...selection.codex,login_store:'/different'}})).toThrow('resume refused');
  expect(()=>bindAuthSelector(selection,undefined)).toThrow('resume refused');
  const synthetic='synthetic-oauth-selection-only';
  const launch=claudeEnvironment('/private/tmp/synthetic-auth-no-files',{CLAUDE_CODE_OAUTH_TOKEN:synthetic,ANTHROPIC_API_KEY:'synthetic-unused-api'});
  expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(synthetic);
  expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(JSON.stringify(launch)).not.toContain(synthetic);
  expect(launch.scrub(synthetic)).not.toContain(synthetic);
  for(const source of [{},{ANTHROPIC_API_KEY:'synthetic-unused-api'},{CLAUDE_CODE_OAUTH_TOKEN:'invalid\nsynthetic'}])
    expect(()=>claudeEnvironment('/private/tmp/synthetic-auth-no-files',source)).toThrow('authentication unavailable');
});

test('Evidence runner forwards only explicitly selected Claude env; missing/ambiguous selection fails before fake child',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-auth-runner-')));
  try{
    for(const name of ['src','scripts','migrations','tests','bin'])fs.mkdirSync(path.join(root,name));
    for(const name of ['package.json','bun.lock','bunfig.toml'])fs.writeFileSync(path.join(root,name),'{}');
    // This is a fake command, never a native CLI or model. It reports only booleans, never secret bytes.
    const fake=path.join(root,'bin/bun');fs.writeFileSync(fake,'#!/usr/bin/python3\nimport os,json\nprint(json.dumps({"selected":bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")),"api":bool(os.environ.get("ANTHROPIC_API_KEY")),"codex":bool(os.environ.get("CODEX_ACCESS_TOKEN"))}))\n',{mode:0o700});
    const wrapper=path.resolve('scripts/p3-command.py'),command=['bun','--no-env-file','scripts/p3-installed-native-check.ts','--execute-real-native','--claude-auth-mode','subscription'];
    const env={PATH:path.join(root,'bin')+':/usr/bin:/bin',CLAUDE_CODE_OAUTH_TOKEN:'synthetic-forwarding-only',ANTHROPIC_API_KEY:'synthetic-not-forwarded',CODEX_ACCESS_TOKEN:'synthetic-not-forwarded'};
    const run=(name:string,forward:boolean,args=command,source:NodeJS.ProcessEnv=env)=>spawnSync('/usr/bin/python3',[wrapper,...(forward?['--claude-subscription-env']:[]),name,...args],{cwd:root,env:source,encoding:'utf8'});
    expect(run('selected',true).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root,'artifacts/p3/selected.log'),'utf8'))).toEqual({selected:true,api:false,codex:false});
    expect(run('default',false).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root,'artifacts/p3/default.log'),'utf8'))).toEqual({selected:false,api:false,codex:false});
    for(const [name,args,source] of [['missing',command,{PATH:env.PATH}],['ambiguous',[...command,'--claude-login-store','/synthetic'],env],['wrong-command',['bun','other.ts'],env]] as const){
      const result=run(name,true,[...args],source);expect(result.status).not.toBe(0);expect(fs.existsSync(path.join(root,'artifacts/p3',name+'.log'))).toBe(false);
      expect(result.stdout+result.stderr).not.toContain(env.CLAUDE_CODE_OAUTH_TOKEN);
    }
    for(const file of fs.readdirSync(path.join(root,'artifacts/p3')))
      expect(fs.readFileSync(path.join(root,'artifacts/p3',file),'utf8')).not.toContain(env.CLAUDE_CODE_OAUTH_TOKEN);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
