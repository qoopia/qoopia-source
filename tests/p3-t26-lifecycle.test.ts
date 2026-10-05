import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { linuxLinger, linuxUserManagerEnvironment, UserAutostart } from '../src/delivery/autostart.ts';
import {lockInstallation} from '../src/delivery/operations.ts';

test('service control remains available while the workspace runs and serializes competing service changes',()=>{
  const f=fixture(),release=lockInstallation(f.installation);
  try{
    const control=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'darwin',configFile:f.config,
      execute:()=>{expect(()=>f.service.remove()).toThrow();}});
    expect(control.install(f.executable).autostart).toBe('enabled');
    expect(control.install(f.executable).native_files_touched).toBe(0);
    expect(f.service.remove().autostart).toBe('removed');
    expect(fs.existsSync(f.config)).toBe(false);
  }finally{release();f.cleanup();}
});

function fixture(allowTestFixture=false) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-t26-'))),installation=path.join(root,'Installed Ж space');
  const nativeDir=path.join(root,'Native Config Ж'),config=path.join(nativeDir,'qoopia.plist'),executable=path.join(root,'Bundle Ж','qoopia');
  fs.mkdirSync(installation,{recursive:true,mode:0o700});fs.mkdirSync(nativeDir,{mode:0o700});fs.mkdirSync(path.dirname(executable),{mode:0o700});fs.writeFileSync(executable,'fixture binary',{mode:0o700});
  const calls:{command:string;args:string[]}[]=[];let fail=false;
  const service=new UserAutostart({root:installation,installation:'fixture-instance',platform:'darwin',configFile:config,allowTestFixture,
    execute:(command,args)=>{calls.push({command,args});if(fail)throw new Error('injected OS command failure');}});
  return {root,installation,nativeDir,config,executable,calls,service,fail:()=>{fail=true;},cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

function programArguments(plist:string){
  const array=plist.split('<key>ProgramArguments</key><array>')[1]?.split('</array>')[0]??'';
  return [...array.matchAll(/<string>(.*?)<\/string>/g)].map(match=>match[1]);
}

test('T26 explicitly authorized test-fixture trust is serialized into Darwin and Linux child argv',()=>{
  const f=fixture(true);try{
    f.service.install(f.executable);
    expect(programArguments(fs.readFileSync(f.config,'utf8'))).toEqual([f.executable,'start','--root',f.installation,'--allow-test-fixture']);
    f.service.remove();
    const config=path.join(f.nativeDir,'qoopia.service'),service=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'linux',configFile:config,allowTestFixture:true,execute:()=>{}});
    service.install(f.executable);
    expect(fs.readFileSync(config,'utf8')).toContain(`ExecStart="${f.executable}" start --root "${f.installation}" --allow-test-fixture`);
  }finally{f.cleanup();}
});

test('T26 a path with systemd specifiers or control characters is written verbatim or refused [F-053]',()=>{
  const f=fixture();try{
    // systemd expands %h and ${VAR} and collapses $$ even inside quotes; %% and $$ are the literal forms.
    const root=path.join(f.root,'a%h${HOME}$$x'),config=path.join(f.nativeDir,'qoopia.service');fs.mkdirSync(root,{mode:0o700});
    new UserAutostart({root,installation:'fixture-instance',platform:'linux',configFile:config,execute:()=>{}}).install(f.executable);
    expect(fs.readFileSync(config,'utf8')).toContain('--root "'+f.root+'/a%%h$${HOME}$$$$x"');
    for(const name of ['ctl\x01x','del\x7fx','tab\tx']){
      const bad=path.join(f.root,name);fs.mkdirSync(bad,{mode:0o700});
      expect(()=>new UserAutostart({root:bad,installation:'fixture-instance',platform:'darwin',configFile:path.join(f.nativeDir,'bad.plist'),execute:()=>{}}).install(f.executable)).toThrow('control characters');
    }
  }finally{f.cleanup();}
});

test('T26 default child argv omits test-fixture trust on Darwin and Linux',()=>{
  const f=fixture();try{
    f.service.install(f.executable);
    expect(programArguments(fs.readFileSync(f.config,'utf8'))).toEqual([f.executable,'start','--root',f.installation]);
    f.service.remove();
    const config=path.join(f.nativeDir,'qoopia.service'),service=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'linux',configFile:config,execute:()=>{}});
    service.install(f.executable);
    expect(fs.readFileSync(config,'utf8')).not.toContain('--allow-test-fixture');
  }finally{f.cleanup();}
});

test('a service an older version pinned to a bundle moves onto the installation launcher at start, on both platforms',()=>{
  for(const platform of ['darwin','linux'] as const){
    const f=fixture();try{
      const config=path.join(f.nativeDir,platform==='darwin'?'qoopia.plist':'qoopia.service'),calls:string[][]=[];
      const service=new UserAutostart({root:f.installation,installation:'fixture-instance',platform,configFile:config,execute:(command,args)=>{calls.push([command,...args]);}});
      // What service install wrote before the launcher: the selected bundle's own binary.
      const pinned=path.join(f.installation,'bundles','a'.repeat(64),'qoopia'),launcher=path.join(f.installation,'bin','qoopia');
      for(const file of [pinned,launcher]){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,path.basename(path.dirname(file)),{mode:0o700});}
      service.install(pinned);fs.rmSync(path.dirname(pinned),{recursive:true});calls.length=0;
      expect(service.retarget(launcher)).toEqual({autostart:'retargeted',native_files_touched:1});
      expect(fs.readFileSync(config,'utf8')).toContain(launcher);expect(fs.readFileSync(config,'utf8')).not.toContain('/bundles/');
      // Nothing restarts; systemd only rereads its units.
      expect(calls).toEqual(platform==='linux'?[['/usr/bin/systemctl','--user','daemon-reload']]:[]);
      expect(service.retarget(launcher)).toEqual({autostart:'current',native_files_touched:0});
      // The ledger owns the rewritten config: the launcher install is idempotent and removal still works.
      expect(service.install(launcher)).toEqual({autostart:'enabled',native_files_touched:0});
      expect(service.remove().autostart).toBe('removed');
      // A config the owner changed, or one naming anything but a bundle, is left exactly as it is.
      service.install(f.executable);
      expect(()=>service.retarget(launcher)).toThrow('does not name an installation bundle');
      fs.appendFileSync(config,'# owner edit\n');const edited=fs.readFileSync(config);
      expect(()=>service.retarget(launcher)).toThrow('changed');expect(fs.readFileSync(config)).toEqual(edited);
    }finally{f.cleanup();}
  }
});

test('a systemd unit written by 5.0.16 (before the restart limits) still moves onto the launcher',()=>{
  const f=fixture();try{
    const config=path.join(f.nativeDir,'qoopia.service'),calls:string[][]=[];
    const pinned=path.join(f.installation,'bundles','b'.repeat(64),'qoopia'),launcher=path.join(f.installation,'bin','qoopia');
    for(const file of [pinned,launcher]){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,path.basename(path.dirname(file)),{mode:0o700});}
    // Exactly what 5.0.16 service install left: its unit bytes and its ledger.
    const legacy=`[Unit]\nDescription=Qoopia user service\n[Service]\nExecStart="${pinned}" start --root "${f.installation}"\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
    const sha=(v:string|Buffer)=>new Bun.CryptoHasher('sha256').update(v).digest('hex');
    fs.writeFileSync(config,legacy,{mode:0o600});fs.mkdirSync(path.join(f.installation,'config'),{mode:0o700});
    fs.writeFileSync(path.join(f.installation,'config','autostart.json'),JSON.stringify({format:'qoopia-autostart-ledger/1',installation:'fixture-instance',platform:'linux',
      native_config:config,config_sha256:sha(legacy),executable_sha256:sha(fs.readFileSync(pinned)),state:'enabled'}),{mode:0o600});
    const service=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'linux',configFile:config,execute:(command,args)=>{calls.push([command,...args]);}});
    expect(service.retarget(launcher)).toEqual({autostart:'retargeted',native_files_touched:1});
    const unit=fs.readFileSync(config,'utf8');expect(unit).toContain(`ExecStart="${launcher}" start`);expect(unit).toContain('StartLimitIntervalSec=0');
    expect(calls).toEqual([['/usr/bin/systemctl','--user','daemon-reload']]);
    expect(service.remove().autostart).toBe('removed');
  }finally{f.cleanup();}
});

test('T26 autostart is explicit, ledger-bound and idempotent',()=>{
  const f=fixture();try{
    expect(f.service.remove()).toEqual({autostart:'never_enabled',native_files_touched:0});expect(f.calls).toEqual([]);
    const installed=f.service.install(f.executable);expect(installed).toEqual({autostart:'enabled',native_files_touched:1});expect(f.calls).toHaveLength(1);
    const ledger=JSON.parse(fs.readFileSync(path.join(f.installation,'config','autostart.json'),'utf8'));
    expect(ledger).toMatchObject({format:'qoopia-autostart-ledger/1',installation:'fixture-instance',platform:'darwin',native_config:f.config});
    expect(f.service.install(f.executable)).toEqual({autostart:'enabled',native_files_touched:0});expect(f.calls).toHaveLength(1);
    expect(f.service.remove()).toEqual({autostart:'removed',native_files_touched:1});expect(f.calls).toHaveLength(2);expect(fs.existsSync(f.config)).toBe(false);
    expect(f.service.remove()).toEqual({autostart:'never_enabled',native_files_touched:0});expect(f.calls).toHaveLength(2);
  }finally{f.cleanup();}
});

test('T26 refuses foreign, changed, symlinked and wrong-identity native config without overbroad deletion',()=>{
  const f=fixture();try{
    const unrelated=path.join(f.nativeDir,'manual.plist');fs.writeFileSync(unrelated,'manual bytes');
    fs.writeFileSync(f.config,'foreign bytes');expect(()=>f.service.install(f.executable)).toThrow('not installer-owned');expect(fs.readFileSync(f.config,'utf8')).toBe('foreign bytes');fs.unlinkSync(f.config);
    f.service.install(f.executable);fs.appendFileSync(f.config,'manual edit');expect(()=>f.service.remove()).toThrow('changed');expect(f.calls).toHaveLength(1);expect(fs.readFileSync(unrelated,'utf8')).toBe('manual bytes');
    fs.unlinkSync(f.config);fs.symlinkSync(unrelated,f.config);expect(()=>f.service.remove()).toThrow();expect(fs.readFileSync(unrelated,'utf8')).toBe('manual bytes');
    fs.unlinkSync(f.config);fs.writeFileSync(f.config,'restored');const ledgerFile=path.join(f.installation,'config','autostart.json'),ledger=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));ledger.installation='foreign';fs.writeFileSync(ledgerFile,JSON.stringify(ledger));expect(()=>f.service.remove()).toThrow('another installation');expect(fs.existsSync(f.config)).toBe(true);
  }finally{f.cleanup();}
});

test('T26 command failure preserves owned config and ledger for safe retry',()=>{
  const f=fixture();try{
    const unrelated=path.join(f.nativeDir,'manual.plist');fs.writeFileSync(unrelated,'manual bytes');
    f.fail();expect(()=>f.service.install(f.executable)).toThrow('injected');expect(fs.existsSync(f.config)).toBe(true);expect(fs.existsSync(path.join(f.installation,'config','autostart.json'))).toBe(true);
    const retry=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'darwin',configFile:f.config,execute:()=>{}});
    expect(retry.remove()).toEqual({autostart:'removed',native_files_touched:1});expect(fs.readFileSync(unrelated,'utf8')).toBe('manual bytes');
    retry.install(f.executable);const failedRemove=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'darwin',configFile:f.config,execute:()=>{throw new Error('injected unload failure');}});
    expect(()=>failedRemove.remove()).toThrow('injected unload failure');expect(fs.existsSync(f.config)).toBe(true);expect(fs.existsSync(path.join(f.installation,'config','autostart.json'))).toBe(true);expect(fs.readFileSync(unrelated,'utf8')).toBe('manual bytes');
  }finally{f.cleanup();}
});

test('T26 Linux user-service config and commands are simulated only in disposable roots',()=>{
  const f=fixture();try{
    const config=path.join(f.nativeDir,'qoopia.service'),calls:{command:string;args:string[]}[]=[],service=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'linux',configFile:config,execute:(command:string,args:string[])=>calls.push({command,args})});
    service.install(f.executable);const unit=fs.readFileSync(config,'utf8');expect(unit).toContain(`ExecStart="${f.executable}" start --root "${f.installation}"`);
    // Keeps retrying while a terminal `qoopia start` holds the port, instead of failing for good after 5 quick tries.
    expect(unit).toContain('\nRestart=on-failure\nRestartSec=5\n');expect(unit).toContain('[Unit]\nDescription=Qoopia user service\nStartLimitIntervalSec=0\n');
    expect(calls.map(c=>c.args.slice(0,2).join(' '))).toEqual(['--user daemon-reload','--user enable']);service.remove();
    expect(calls.map(c=>c.args.slice(0,2).join(' '))).toEqual(['--user daemon-reload','--user enable','--user disable','--user daemon-reload']);
  }finally{f.cleanup();}
});

test('T26 Linux native user manager receives only existing session bus discovery variables',()=>{
  const source={PATH:'/fixture/bin',HOME:'/fixture/home',XDG_CONFIG_HOME:'/fixture/config',XDG_RUNTIME_DIR:'/run/user/1001',
    DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1001/bus',ANTHROPIC_API_KEY:'must-not-cross',QOOPIA_ALLOW_TEST_FIXTURE:'must-not-cross'};
  const env={PATH:source.PATH,HOME:source.HOME,XDG_CONFIG_HOME:source.XDG_CONFIG_HOME,...linuxUserManagerEnvironment('linux',source)};
  const child=spawnSync('/usr/bin/env',[],{encoding:'utf8',env});
  expect(child.status).toBe(0);
  expect(Object.fromEntries(child.stdout.trim().split('\n').map(line=>line.split(/=(.*)/s).slice(0,2)))).toEqual({
    PATH:source.PATH,HOME:source.HOME,XDG_CONFIG_HOME:source.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR:source.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:source.DBUS_SESSION_BUS_ADDRESS});
  expect(linuxUserManagerEnvironment('linux',{})).toEqual({});
  expect(linuxUserManagerEnvironment('darwin',source)).toEqual({});
  expect(()=>linuxUserManagerEnvironment('linux',{XDG_RUNTIME_DIR:'relative',DBUS_SESSION_BUS_ADDRESS:source.DBUS_SESSION_BUS_ADDRESS})).toThrow('XDG_RUNTIME_DIR');
  expect(()=>linuxUserManagerEnvironment('linux',{XDG_RUNTIME_DIR:source.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:'tcp:host=elsewhere'})).toThrow('DBUS_SESSION_BUS_ADDRESS');
});

test('T26 replacement race during unload is preserved and ledger remains for review',()=>{
  const f=fixture();try{
    f.service.install(f.executable);const racing=new UserAutostart({root:f.installation,installation:'fixture-instance',platform:'darwin',configFile:f.config,
      execute:(_command:string,args:string[])=>{if(args[0]==='unload'){fs.unlinkSync(f.config);fs.writeFileSync(f.config,'replacement bytes');}}});
    expect(()=>racing.remove()).toThrow('replacement preserved');expect(fs.readFileSync(f.config,'utf8')).toBe('replacement bytes');expect(fs.existsSync(path.join(f.installation,'config','autostart.json'))).toBe(true);
  }finally{f.cleanup();}
});

test('T26 rejects ledger traversal and leaves unrelated files untouched',()=>{
  const f=fixture();try{
    f.service.install(f.executable);const unrelated=path.join(f.root,'unrelated');fs.writeFileSync(unrelated,'keep');
    const ledgerFile=path.join(f.installation,'config','autostart.json'),ledger=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));ledger.native_config=path.join(f.installation,'..','unrelated');fs.writeFileSync(ledgerFile,JSON.stringify(ledger));
    expect(()=>f.service.remove()).toThrow('native config identity');expect(fs.readFileSync(unrelated,'utf8')).toBe('keep');expect(f.calls).toHaveLength(1);
  }finally{f.cleanup();}
});

test('Linux autostart reports when lingering is off, so a headless server would not start after a reboot',()=>{
  expect(linuxLinger('ann',()=> 'yes\n')).toEqual({linger:'enabled'});
  expect(linuxLinger('ann',()=> 'no\n')).toEqual({linger:'disabled',next_action:'To start Qoopia after a reboot without logging in, run: loginctl enable-linger ann'});
  expect(linuxLinger('ann',()=>undefined).linger).toBe('unknown');
});
