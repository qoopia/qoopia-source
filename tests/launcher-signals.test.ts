import { expect, test } from 'bun:test';
import { runForwardingSignals, installationLauncher } from '../src/delivery/launcher.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The child exits 7 on TERM and 8 on INT, so the status proves which signal reached it.
const child = () => runForwardingSignals('/bin/sh', ['-c', 'trap "exit 7" TERM; trap "exit 8" INT; echo ready; while :; do sleep 0.05; done'], { stdio: ['ignore', 'pipe', 'ignore'] });

test('killing the dispatching launcher stops its server child instead of orphaning it', async () => {
  const before = ['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => process.listenerCount(signal));
  for (const [received, status] of [['SIGTERM', 7], ['SIGINT', 8], ['SIGHUP', 7]] as const) {
    const running = child();
    await Bun.sleep(300);
    process.emit(received);
    expect(await running).toBe(status);
  }
  // Handlers are removed once the child exits.
  expect(['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => process.listenerCount(signal))).toEqual(before);
  // A child ended by a signal it does not trap reports 128+signal.
  const killed = runForwardingSignals('/bin/sh', ['-c', 'kill -KILL $$'], { stdio: 'ignore' });
  expect(await killed).toBe(137);
});

test('a computer that opens a server workspace keeps hooks on the opening binary, not an inactive local install',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-launcher-')));
  try{
    fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({bundle:'a'.repeat(64)}));
    expect(installationLauncher(root,process.execPath)).toBe(path.join(root,'bin','qoopia'));
    fs.writeFileSync(path.join(root,'server-workspace.json'),JSON.stringify({format:'qoopia-server-workspace/1',url:'https://example.invalid/dashboard'}));
    expect(installationLauncher(root,process.execPath)).toBe(fs.realpathSync(process.execPath));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
