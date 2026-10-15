import { expect, test } from 'bun:test';
import { dispatchEnvironment } from '../src/delivery/entry.ts';

// The downloaded package (and the Mac app's bundled binary) hands `open` to the installed bundle. Bun's
// os.userInfo().username reads $USER, so without it the first owner was bootstrapped as "unknown".
test('the installed runtime keeps the desktop user name and nothing beyond the allowlist', () => {
  const env = dispatchEnvironment({ USER: 'alex', LOGNAME: 'alex', HOME: '/home/alex', TMPDIR: '/tmp/x', OPENAI_API_KEY: 'sk-never', QOOPIA_ADMIN_SECRET: 'never' });
  expect(env).toMatchObject({ USER: 'alex', LOGNAME: 'alex', HOME: '/home/alex', TMPDIR: '/tmp/x' });
  expect(Object.values(env)).not.toContain('sk-never');
  expect(Object.values(env)).not.toContain('never');
});

// A6-02: the wake routes are the one operator setting that reaches the isolated server.
test('AgentComm wake routes reach the server from its environment and from a private agentcomm.env, nothing else', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { agentcommEnvironment } = await import('../src/delivery/entry.ts');
  const env = dispatchEnvironment({ USER: 'alex', AGENTCOMM_BOT_WEBHOOK_URL: 'http://100.1.2.3:8790/hooks/agentcomm/bot', AGENTCOMM_BOT_WEBHOOK_SECRET: 's', OTHER: 'x' });
  expect(env).toMatchObject({ AGENTCOMM_BOT_WEBHOOK_URL: 'http://100.1.2.3:8790/hooks/agentcomm/bot', AGENTCOMM_BOT_WEBHOOK_SECRET: 's' });
  expect(Object.values(env)).not.toContain('x');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-agentcomm-env-')), file = path.join(dir, 'agentcomm.env');
  try {
    fs.writeFileSync(file, 'AGENTCOMM_MAC_WEBHOOK_URL=http://127.0.0.1:8790/hooks/agentcomm/mac\nAGENTCOMM_MAC_WEBHOOK_SECRET=abc=def\nOTHER_SETTING=ignored\n', { mode: 0o600 });
    expect(agentcommEnvironment({ AGENTCOMM_X_WEBHOOK_URL: 'u' }, file)).toEqual({ AGENTCOMM_X_WEBHOOK_URL: 'u', AGENTCOMM_MAC_WEBHOOK_URL: 'http://127.0.0.1:8790/hooks/agentcomm/mac', AGENTCOMM_MAC_WEBHOOK_SECRET: 'abc=def' });
    fs.chmodSync(file, 0o644);
    expect(agentcommEnvironment({}, file)).toEqual({});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
