"""deploy/release-source-check.sh: the owner preview is a valid state, a deploy window only reports,
and a real mismatch still fails (A5-06, A7-16)."""
import datetime
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/release-source-check.sh'
PUBLIC, PREVIEW = 'f9a554ed3589' + 'a' * 28, 'cfce4058889e' + 'b' * 28


@unittest.skipUnless(SCRIPT.exists(), 'private operator script (not in the public source export)')
class ReleaseSourceCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        t = Path(self.temp.name)
        self.root, self.monitor, bin_dir = t / 'qoopia', t / 'monitor', t / 'bin'
        for d in (self.root / 'releases' / PREVIEW[:12], self.root / 'releases' / PUBLIC[:12], self.monitor, bin_dir):
            d.mkdir(parents=True)
        (self.root / 'current').symlink_to(self.root / 'releases' / PREVIEW[:12])
        running = PREVIEW
        (bin_dir / 'docker').write_text('#!/bin/bash\ncase "$*" in *revision*) echo %s;; *config_files*) echo %s/releases/%s/compose.yml;; esac\n'
                                        % (running, self.root, running[:12]))
        (bin_dir / 'curl').write_text('#!/bin/bash\necho \'{"release_sha":"%s"}\'\n' % running)
        for name in ('docker', 'curl'):
            os.chmod(bin_dir / name, 0o755)
        self.env = {**os.environ, 'PATH': '%s:%s' % (bin_dir, os.environ['PATH']), 'QOOPIA_ROOT': str(self.root), 'QOOPIA_MONITOR_ROOT': str(self.monitor)}

    def tearDown(self):
        self.temp.cleanup()

    def check(self, env_lines):
        (self.monitor / 'release.env').write_text('\n'.join(env_lines) + '\n')
        r = subprocess.run(['bash', str(SCRIPT)], env=self.env, capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout.strip()

    def test_owner_preview_is_healthy(self):
        code, out = self.check(['QOOPIA_RELEASE_SHA=' + PUBLIC, 'QOOPIA_PREVIEW_RELEASE_SHA=' + PREVIEW])
        self.assertEqual((code, out.split()[0]), (0, 'OK'), out)

    def test_public_expectation_while_preview_runs_fails_unless_in_a_deploy_window(self):
        code, out = self.check(['QOOPIA_RELEASE_SHA=' + PUBLIC, 'QOOPIA_PREVIEW_RELEASE_SHA='])
        self.assertEqual(code, 1)
        self.assertIn('monitor_public=f9a554ed3589', out)
        (self.monitor / 'maintenance-until').write_text((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)).isoformat())
        code, out = self.check(['QOOPIA_RELEASE_SHA=' + PUBLIC])
        self.assertEqual((code, out.split()[0]), (0, 'MAINTENANCE'))


if __name__ == '__main__':
    unittest.main()
