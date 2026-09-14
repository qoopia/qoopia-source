import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserEnvironment, openBrowser } from '../src/delivery/browser-open.ts';

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
