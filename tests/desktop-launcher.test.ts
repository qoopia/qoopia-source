import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareDesktopLauncher} from '../src/delivery/desktop-launcher.ts';import {privateDirectory,durableWrite} from '../src/utils/fs.ts';

test('Desktop launcher follows the selected bundle, quotes literal paths, and refuses modified files or pointer traversal',()=>{
  if(process.platform!=='darwin')return; // This adapter uses the official macOS Desktop surface.
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"qoopia-desktop ' $fixture-"))),id=randomUUID(),binary=path.join(root,'app');
  const binding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface:'claude_desktop',access_mode:'read',mcp_url:'http://127.0.0.1:3737/mcp/c/'+id};
  const fake='#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n';durableWrite(binary,fake,0o700);
  try{
    const plan=prepareDesktopLauncher(root,binding,binary);expect(fs.existsSync(path.join(root,'client-configs'))).toBe(false);
    const applied=prepareDesktopLauncher(root,binding,binary,true,true);expect(applied.entry).toEqual(plan.entry);
    const run=()=>spawnSync(applied.entry.command,applied.entry.args,{encoding:'utf8'});
    const fallback=run();expect(fallback.status).toBe(0);expect(fallback.stdout.split('\n').slice(0,3)).toEqual([binary,'client-stdio','--root']);
    expect(fallback.stdout).toContain('--allow-test-fixture');
    for(const hash of ['a'.repeat(64),'b'.repeat(64)]){
      const folder=privateDirectory(path.join(root,'bundles',hash));durableWrite(path.join(folder,'qoopia'),fake,0o700);
      durableWrite(path.join(root,'current.json'),JSON.stringify({bundle:hash}));
      const current=run();expect(current.status).toBe(0);expect(current.stdout.split('\n')[0]).toBe(path.join(folder,'qoopia'));
    }
    durableWrite(path.join(root,'current.json'),JSON.stringify({bundle:'../../outside'}));expect(run().status).toBe(64);
    const launcher=applied.entry.args[0]!;const original=fs.readFileSync(launcher,'utf8');
    prepareDesktopLauncher(root,binding,binary,true,true);expect(fs.readFileSync(launcher,'utf8')).toBe(original);
    fs.appendFileSync(launcher,'# changed outside');expect(()=>prepareDesktopLauncher(root,binding,binary,true,true)).toThrow('changed outside');
    expect(fs.readFileSync(launcher,'utf8')).toBe(original+'# changed outside');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the Mac app shows the runtime refusal reason and warns when run from the disk image or Downloads',()=>{
  const swift=fs.readFileSync('scripts/darwin-launcher.swift','utf8'),entry=fs.readFileSync('src/delivery/entry.ts','utf8');
  // desktop-prepare explains e.g. "This app is older than the installed Qoopia"; a discarded stderr hid it.
  const prefix='Qoopia operation refused: ';
  expect(entry).toContain(`console.error('${prefix}'`);expect(swift).toContain(`"${prefix}"`);
  expect(swift).toContain('process.arguments = ["desktop-prepare", "--commit"]; process.standardOutput = pipe; process.standardError = errors');
  expect(swift).toContain('if runsFromTemporaryLocation { warnTemporaryLocation() }');
  expect(swift).toContain('if runsFromTemporaryLocation && SMAppService.mainApp.status != .enabled { warnTemporaryLocation(); return }');
  // Opening a .qoopia-memory file answers in the Mac's language too.
  expect(swift).toContain('self.text("Connection configured", "Подключение настроено")');
  expect(swift).not.toContain('alert.messageText = "Connection could not be installed"');
  expect(swift).toContain('"Перезапустите или откройте сессию Claude Code. Контекст сохраняется и восстанавливается автоматически."');
  if(process.platform!=='darwin'||spawnSync('xcrun',['--find','swiftc']).status!==0)return;
  const check=spawnSync('xcrun',['swiftc','-typecheck','-target','arm64-apple-macos15.0','scripts/darwin-launcher.swift'],{encoding:'utf8',timeout:120_000});
  expect(check.stderr).toBe('');expect(check.status).toBe(0);
});
