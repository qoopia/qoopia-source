import { expect, test } from 'bun:test';
import { dispatchEnvironment, mcpSurfaceEnvironment } from '../src/delivery/entry.ts';

// The downloaded package (and the Mac app's bundled binary) hands `open` to the installed bundle. Bun's
// os.userInfo().username reads $USER, so without it the first owner was bootstrapped as "unknown".
test('the installed runtime keeps the desktop user name and nothing beyond the allowlist', () => {
  const env = dispatchEnvironment({ USER: 'alex', LOGNAME: 'alex', HOME: '/home/user', TMPDIR: '/tmp/x', OPENAI_API_KEY: 'sk-never', QOOPIA_ADMIN_SECRET: 'never', QOOPIA_TOOL_SURFACE:'classic', QOOPIA_CODE_MODE:'off' });
  expect(env).toMatchObject({ USER: 'alex', LOGNAME: 'alex', HOME: '/home/user', TMPDIR: '/tmp/x', QOOPIA_TOOL_SURFACE:'classic', QOOPIA_CODE_MODE:'off' });
  expect(Object.values(env)).not.toContain('sk-never');
  expect(Object.values(env)).not.toContain('never');
  // The same allowlist configures the actual isolated server after launcher dispatch.
  expect(mcpSurfaceEnvironment(env)).toEqual({QOOPIA_TOOL_SURFACE:'classic',QOOPIA_CODE_MODE:'off'});
  expect(mcpSurfaceEnvironment({QOOPIA_TOOL_SURFACE:'lean',QOOPIA_CODE_MODE:'on'})).toEqual({QOOPIA_TOOL_SURFACE:'lean',QOOPIA_CODE_MODE:'on'});
  expect(mcpSurfaceEnvironment({QOOPIA_TOOL_SURFACE:'invalid',QOOPIA_CODE_MODE:'invalid',QOOPIA_API_KEY:'never'})).toEqual({});
});

// A6-02: wake routes also reach the isolated server without ambient provider credentials.
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
