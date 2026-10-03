import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserEnvironment, openBrowser, presentWorkspace } from '../src/delivery/browser-open.ts';

function fixture(run:(root:string,env:NodeJS.ProcessEnv,write:(name:string,status?:number)=>void)=>void){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-browser-'));
  const env=browserEnvironment({HOME:root,PATH:root,DISPLAY:':42',XDG_DATA_DIRS:'/synthetic/snap/desktop',QOOPIA_ADMIN_SECRET:'must-not-forward'});
  const write=(name:string,status=0)=>fs.writeFileSync(path.join(root,name),
    '#!/bin/sh\nprintf "%s\\0" "$0" "$@" "$DISPLAY" "$XDG_DATA_DIRS" "${QOOPIA_ADMIN_SECRET-}" > "$HOME/observed"\nexit '+status+'\n',{mode:0o755});
  try{run(root,env,write);}finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('missing xdg-open uses the installed XFCE browser handler with literal URL and bounded desktop environment',()=>fixture((root,env,write)=>{
  write('exo-open');write('gio',93);
  const url='http://127.0.0.1:3737/dashboard#setup=synthetic;$(touch '+path.join(root,'SHOULD-NOT-EXIST')+')';
  expect(openBrowser(url,env,'linux')).toBe(true);
  expect(fs.readFileSync(path.join(root,'observed'),'utf8').split('\0')).toEqual([
    path.join(root,'exo-open'),'--launch','WebBrowser',url,':42','/synthetic/snap/desktop','','']);
  expect(fs.existsSync(path.join(root,'SHOULD-NOT-EXIST'))).toBe(false);
}));

test('GIO opens the URL when both earlier desktop utilities are absent',()=>fixture((root,env,write)=>{
  write('gio');expect(openBrowser('https://example.com/',env,'linux')).toBe(true);
  expect(fs.readFileSync(path.join(root,'observed'),'utf8').split('\0').slice(0,3)).toEqual([path.join(root,'gio'),'open','https://example.com/']);
}));

test('an existing opener failure never repeats the URL through another handler',()=>fixture((root,env,write)=>{
  write('xdg-open',1);write('exo-open');write('gio');
  expect(openBrowser('https://example.com/',env,'linux')).toBe(false);
  expect(fs.readFileSync(path.join(root,'observed'),'utf8').split('\0')[0]).toBe(path.join(root,'xdg-open'));
}));

test('an interrupted opener and a desktop without any opener refuse without fallback side effects',()=>fixture((root,env,write)=>{
  expect(openBrowser('https://example.com/',env,'linux')).toBe(false);
  fs.writeFileSync(path.join(root,'xdg-open'),'#!/bin/sh\nkill -TERM $$\n',{mode:0o755});write('exo-open');
  expect(openBrowser('https://example.com/',env,'linux')).toBe(false);
  expect(fs.existsSync(path.join(root,'observed'))).toBe(false);
}));

test('open without a desktop browser keeps serving and prints the address and an SSH tunnel hint, never the setup code',()=>fixture((root,env,write)=>{
  const code='a'.repeat(32),printed:string[]=[],linux=(url:string,environment:NodeJS.ProcessEnv)=>openBrowser(url,environment,'linux');
  expect(presentWorkspace(37335,code,env,linux,line=>printed.push(line))).toBe(false);
  const output=printed.join('\n');
  expect(output).toContain('http://127.0.0.1:37335/dashboard');
  expect(output).toContain('ssh -L 37335:127.0.0.1:37335');
  expect(output).toContain('qoopia owner-login');
  expect(output).not.toContain(code);
  // A desktop opener still receives the single-use setup URL and no headless hint is printed.
  write('xdg-open');printed.length=0;
  expect(presentWorkspace(37335,code,env,linux,line=>printed.push(line))).toBe(true);
  expect(fs.readFileSync(path.join(root,'observed'),'utf8').split('\0')[1]).toBe('http://127.0.0.1:37335/dashboard#setup='+code);
  expect(printed.join('\n')).not.toContain('ssh -L');
  // The launcher no longer turns a missing browser into a refused command that stops the server it just started.
  const entry=fs.readFileSync(new URL('../src/delivery/entry.ts',import.meta.url),'utf8');
  expect(entry).not.toContain('Could not open your browser');
  expect(entry).toContain('presentWorkspace(current.port,code,');
}));
