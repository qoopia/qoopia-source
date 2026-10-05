import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeServerWorkspace, readServerWorkspace, selectServerWorkspace } from '../src/delivery/remote.ts';

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
    // doctor and support-preview describe the server workspace, not the inactive local installation left in the folder,
    // and say whether the server answers instead of a blind ok. (.invalid never resolves: no real server is contacted.)
    selectServerWorkspace(root,'https://qoopia-fixture.invalid');
    for(const command of ['doctor','support-preview']){
      const run=spawnSync(process.execPath,['src/delivery/entry.ts',command,'--root',root],{encoding:'utf8'});
      expect(run.status).toBe(command==='doctor'?1:0);
      expect(JSON.parse(run.stdout)).toMatchObject({state:'SERVER_WORKSPACE',url:'https://qoopia-fixture.invalid/dashboard',data_location:'server',local_installation:'inactive',server:'unreachable'});
    }
    expect(JSON.parse(spawnSync(process.execPath,['src/delivery/entry.ts','doctor','--root',root],{encoding:'utf8'}).stdout)).toMatchObject({ok:false,status:'server_unreachable'});
    // use-server does not silently select an address that does not answer; an explicit confirmation does.
    const refused=spawnSync(process.execPath,['src/delivery/entry.ts','use-server','--root',root,'--url','https://other-fixture.invalid','--commit'],{encoding:'utf8'});
    expect(refused.status).toBe(1);expect(refused.stderr).toContain('--confirm-server');
    expect(readServerWorkspace(root)).toBe('https://qoopia-fixture.invalid/dashboard');
    const confirmed=spawnSync(process.execPath,['src/delivery/entry.ts','use-server','--root',root,'--url','https://other-fixture.invalid','--commit','--confirm-server'],{encoding:'utf8'});
    expect(confirmed.status).toBe(0);expect(JSON.parse(confirmed.stdout).server).toBe('unreachable');
    expect(readServerWorkspace(root)).toBe('https://other-fixture.invalid/dashboard');
    selectServerWorkspace(root,'https://mcp.qoopia.ai');
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

test('the server probe recognises only a Qoopia /health answer and sends no credentials', async () => {
  const seen: {url: string; init: RequestInit}[] = [];
  const fake = (status: number, body: string) => (async (url: string, init: RequestInit) => { seen.push({url, init}); return new Response(body, {status}); }) as unknown as typeof fetch;
  expect(await probeServerWorkspace('https://server.example/dashboard', fake(200, JSON.stringify({status: 'ok', version: '5.0.17', server_role: 'canonical'})))).toBe('reachable');
  expect(seen[0]!.url).toBe('https://server.example/health');
  expect(seen[0]!.init).toMatchObject({credentials: 'omit', redirect: 'error'});
  expect(JSON.stringify(seen[0]!.init.headers)).not.toMatch(/authorization|cookie/i);
  expect(await probeServerWorkspace('https://server.example', fake(404, '<html>Not found</html>'))).toBe('not_qoopia');
  expect(await probeServerWorkspace('https://server.example', fake(200, '{"status":"ok"}'))).toBe('not_qoopia');
  expect(await probeServerWorkspace('https://server.example', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBe('unreachable');
});
