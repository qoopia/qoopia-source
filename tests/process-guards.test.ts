import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const guards = fileURLToPath(new URL('../src/utils/process-guards.ts', import.meta.url));
async function run(body: string) {
  const script = `const {installProcessGuards}=await import(${JSON.stringify(guards)});
installProcessGuards(reason=>{console.log('FATAL '+reason);process.exit(3);});
${body}`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, QOOPIA_LOG_LEVEL: 'error' } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: stdout + stderr, code };
}

test('a forgotten rejection is logged and the server keeps running [A1-05]', async () => {
  const { out, code } = await run(`setTimeout(()=>{void Promise.reject(new Error('lost rejection'));},1);setTimeout(()=>console.log('STILL SERVING'),50);`);
  expect(out).toContain('Unhandled promise rejection');
  expect(out).toContain('lost rejection');
  expect(out).toContain('STILL SERVING');
  expect(code).toBe(0);
});

test('an uncaught exception is logged and stops the server through its shutdown [A1-05]', async () => {
  const { out, code } = await run(`setTimeout(()=>{throw new Error('broken state');},1);setTimeout(()=>console.log('STILL SERVING'),200);`);
  expect(out).toContain('Uncaught exception; stopping');
  expect(out).toContain('FATAL uncaughtException');
  expect(out).not.toContain('STILL SERVING');
  expect(code).toBe(3);
});
