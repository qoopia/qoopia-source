import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { linuxUserManagerEnvironment, UserAutostart } from '../src/delivery/autostart.ts';
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
