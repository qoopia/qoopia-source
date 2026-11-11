import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const guards = fileURLToPath(new URL('../src/utils/process-guards.ts', import.meta.url));
async function run(body: string, level = 'error') {
  const script = `const {installProcessGuards}=await import(${JSON.stringify(guards)});
installProcessGuards(reason=>{console.log('FATAL '+reason);process.exit(3);});
${body}`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, QOOPIA_LOG_LEVEL: level } });
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

test('a timer body that throws costs that tick, not the server: it is logged and the timer runs on [X11]', async () => {
  const logger = fileURLToPath(new URL('../src/utils/logger.ts', import.meta.url));
  const { out, code } = await run(`const {guardedTick}=await import(${JSON.stringify(logger)});let ticks=0;
const timer=setInterval(guardedTick('Synthetic timer',()=>{ticks++;throw new Error('database is locked');}),5);
setTimeout(()=>{clearInterval(timer);console.log('TICKS '+(ticks>1));},80);`, 'warn');
  expect(out).toContain('Synthetic timer failed');
  expect(out).toContain('database is locked');
  expect(out).not.toContain('FATAL');
  expect(out).toContain('TICKS true');
  expect(code).toBe(0);
});
