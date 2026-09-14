import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readServerWorkspace, selectServerWorkspace } from '../src/delivery/remote.ts';

test('server selection preserves local data and refuses unsafe or damaged selections', () => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-server-')));
  try {
    expect(readServerWorkspace(root)).toBeUndefined();
    fs.writeFileSync(path.join(root,'current.json'),'existing installation');
    expect(selectServerWorkspace(root,'https://mcp.qoopia.ai').url).toBe('https://mcp.qoopia.ai/dashboard');
    expect(readServerWorkspace(root)).toBe('https://mcp.qoopia.ai/dashboard');
    expect(fs.readFileSync(path.join(root,'current.json'),'utf8')).toBe('existing installation');
    const setup=spawnSync(process.execPath,['src/delivery/entry.ts','setup','--root',root],{encoding:'utf8'});
    expect(setup.status).toBe(0);
    expect(JSON.parse(setup.stdout).state).toBe('SERVER_WORKSPACE');
    const start=spawnSync(process.execPath,['src/delivery/entry.ts','start','--root',root],{encoding:'utf8'});
    expect(start.status).toBe(1);
    expect(start.stderr).toContain('This installation uses a server workspace');
    expect(fs.existsSync(path.join(root,'data'))).toBe(false);
    for(const url of ['http://example.com','javascript:alert(1)','https://user:secret@example.com','https://example.com/dashboard?token=secret','https://example.com/other','https://example.com/#secret']) {
      expect(()=>selectServerWorkspace(root,url)).toThrow();
      expect(readServerWorkspace(root)).toBe('https://mcp.qoopia.ai/dashboard');
    }
    fs.writeFileSync(path.join(root,'server-workspace.json'),'{broken');
    expect(()=>readServerWorkspace(root)).toThrow();
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
