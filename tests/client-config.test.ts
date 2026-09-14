import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {configureNativeClient} from '../src/delivery/client-config.ts';
import {privateDirectory,durableWrite} from '../src/delivery/files.ts';
import {nativeClientDirectory} from '../src/delivery/native-client-paths.ts';

test('native config supports vendor override directories and resumes the selected file without a shell environment',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-custom-config-')),home=path.join(root,'home');privateDirectory(home);
  try{
    for(const surface of ['codex','claude_code'] as const){
      const id=randomUUID(),directory=privateDirectory(path.join(root,surface+' custom'));
      const binding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface,access_mode:'read',mcp_url:'http://127.0.0.1:3737/mcp/c/'+id};
      const variable=surface==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR';
      expect(nativeClientDirectory(surface,{[variable]:directory})).toBe(directory);
      expect(()=>nativeClientDirectory(surface,{[variable]:'relative'})).toThrow('absolute');
      const defaults=configureNativeClient(root,binding,'plan',home);
      const custom=configureNativeClient(root,binding,'plan',home,directory);
      expect(custom.plan_digest).not.toBe(defaults.plan_digest);
      expect(custom.configuration_file).toBe(path.join(directory,surface==='codex'?'config.toml':'.claude.json'));
      configureNativeClient(root,binding,'apply',home,directory);
      expect(configureNativeClient(root,binding,'status',home).configuration_file).toBe(custom.configuration_file);
      expect(fs.readdirSync(home)).toEqual([]);
      expect(()=>configureNativeClient(root,binding,'apply',home,path.join(root,'different'))).toThrow('another selection');
      configureNativeClient(root,binding,'remove',home);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('native OAuth configuration preserves unrelated settings, survives retries and only removes its own unchanged entry',()=>{
  for(const surface of ['codex','claude_code'] as const){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-native-config-')),home=path.join(root,'home'),id=randomUUID();
    privateDirectory(home);fs.chmodSync(home,0o755); // ordinary user home; do not require or change its access mode
    if(surface==='codex')privateDirectory(path.join(home,'.codex'));
    const file=path.join(home,surface==='codex'?'.codex/config.toml':'.claude.json');
    const before=surface==='codex'?'# Preserve my comment\nmodel = "fixture-model"\n[mcp_servers.existing]\nurl = "https://existing.example/mcp"\nhttp_headers = { Authorization = "fixture-private-value" }\n':
      JSON.stringify({theme:'dark',mcpServers:{existing:{type:'http',url:'https://existing.example/mcp',headers:{Authorization:'fixture-private-value'}}}});
    durableWrite(file,before);
    const binding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:randomUUID(),surface,access_mode:'read',mcp_url:'http://127.0.0.1:3737/mcp/c/'+id};
    const act=(action:'plan'|'apply'|'status'|'remove')=>configureNativeClient(root,binding,action,home);
    try{
      const plan=act('plan');expect(plan.code).toBe('CLIENT_CONFIG_APPLY_REQUIRED');expect(fs.readFileSync(file,'utf8')).toBe(before);
      expect(JSON.stringify(plan)).not.toContain('fixture-private-value');expect(fs.existsSync(path.join(root,'client-configs'))).toBe(false);
      const applied=act('apply');expect(applied.code).toBe('CLIENT_AUTH_REQUIRED');expect(applied.verified).toBe(false);
      const changed=fs.readFileSync(file,'utf8');expect(changed).toContain('fixture-private-value');
      expect(act('apply').code).toBe('CLIENT_AUTH_REQUIRED');expect(fs.readFileSync(file,'utf8')).toBe(changed);
      expect(act('status').configuration_present).toBe(true);
      const dir=path.join(root,'client-configs',id),files=fs.readdirSync(dir);
      expect(files.filter(f=>f.endsWith('.bak'))).toHaveLength(1);
      for(const name of files)expect(fs.statSync(path.join(dir,name)).mode&0o777).toBe(0o600);
      expect(fs.statSync(home).mode&0o777).toBe(0o755);
      if(surface==='codex')fs.appendFileSync(file,'# A new unrelated comment\n');
      expect(act('remove').code).toBe('CLIENT_CONFIG_REMOVED');
      expect(act('remove').code).toBe('CLIENT_CONFIG_REMOVED');
      const restored=fs.readFileSync(file,'utf8');
      if(surface==='codex')expect(restored).toBe(before+'# A new unrelated comment\n');
      else expect(JSON.parse(restored)).toEqual(JSON.parse(before));
      expect(act('status').configuration_present).toBe(false);
      act('apply');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(binding.mcp_url,'https://changed.example/mcp'));
      const drifted=fs.readFileSync(file,'utf8');expect(()=>act('remove')).toThrow('changed outside');expect(()=>act('apply')).toThrow('changed outside');
      expect(fs.readFileSync(file,'utf8')).toBe(drifted);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('native file import refuses mismatched resource identities and linked configuration paths before editing',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-config-paths-')),home=path.join(root,'home'),id=randomUUID();privateDirectory(home);
  const binding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface:'claude_code',access_mode:'read',mcp_url:'https://fixture.example/mcp/c/'+id};
  try{
    expect(()=>configureNativeClient(root,{...binding,mcp_url:'https://fixture.example/mcp/c/'+randomUUID()},'apply',home)).toThrow('exact prepared');
    expect(fs.readdirSync(home)).toEqual([]);
    const target=path.join(root,'unrelated.json');durableWrite(target,'{"keep":true}');fs.symlinkSync(target,path.join(home,'.claude.json'));
    expect(()=>configureNativeClient(root,binding,'apply',home)).toThrow();expect(fs.readFileSync(target,'utf8')).toBe('{"keep":true}');
    expect(fs.existsSync(path.join(root,'client-configs'))).toBe(false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Claude Desktop config adds a private launcher and an explicit OAuth handoff without changing unrelated servers',()=>{
  if(process.platform!=='darwin')return;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-desktop-config-')),home=path.join(root,'home'),id=randomUUID();
  const directory=privateDirectory(path.join(home,'Library/Application Support/Claude')),file=path.join(directory,'claude_desktop_config.json');
  durableWrite(file,JSON.stringify({theme:'dark',mcpServers:{existing:{command:'/fixture/keep',args:['keep']}}}));
  const binding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface:'claude_desktop',access_mode:'read',mcp_url:'http://127.0.0.1:3737/mcp/c/'+id};
  try{
    const plan=configureNativeClient(root,binding,'plan',home);expect(plan.code).toBe('CLIENT_CONFIG_APPLY_REQUIRED');
    const applied=configureNativeClient(root,binding,'apply',home);expect(applied.verified).toBe(false);
    const config=JSON.parse(fs.readFileSync(file,'utf8'));expect(config.theme).toBe('dark');expect(config.mcpServers.existing.command).toBe('/fixture/keep');
    expect(config.mcpServers[applied.configuration_name].command).toBe('/bin/sh');expect(JSON.stringify(config)).not.toContain('Bearer');
    expect(applied.authentication_argv).toContain('client-auth');expect(applied.authentication_argv).toContain('--commit');
    expect(JSON.parse(fs.readFileSync(applied.binding_file!,'utf8')).mcp_url).toBe(binding.mcp_url);
    expect(configureNativeClient(root,binding,'apply',home).plan_digest).toBe(plan.plan_digest);
    configureNativeClient(root,binding,'remove',home);
    expect(configureNativeClient(root,binding,'remove',home).code).toBe('CLIENT_CONFIG_REMOVED');
    expect(Object.keys(JSON.parse(fs.readFileSync(file,'utf8')).mcpServers)).toEqual(['existing']);
    durableWrite(file,JSON.stringify(config));
    expect(()=>configureNativeClient(root,binding,'remove',home)).toThrow('no ownership receipt');
    expect(JSON.parse(fs.readFileSync(file,'utf8'))).toEqual(config);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
