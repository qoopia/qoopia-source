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
