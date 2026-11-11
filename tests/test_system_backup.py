"""deploy/corsair-system-backup.sh with stub docker/restic/crontab: a database dump that fails is a failed
backup, the memory server's configuration is in the snapshot, and only a memory backup that passed its
checks is taken."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / 'deploy/corsair-system-backup.sh'

DOCKER = r"""#!/bin/bash
# docker exec <container> sh -c <dump>; docker ps
[ "$1" = ps ] && { echo 'memory image'; exit 0; }
[ "${DUMP:-ok}" = ok ] && { echo 'CREATE TABLE t(x);'; exit 0; }
exit 1
"""
# restic records what it was asked to back up, and whether the dump file was there and had bytes.
RESTIC = r"""#!/bin/bash
case " $* " in *' backup '*) printf '%s\n' "$@" >> "$RESTIC_LOG"
  for a in "$@"; do [ -d "$a" ] && [ -e "$a/nextcloud-db.sql" ] && echo "dump-bytes=$(wc -c < "$a/nextcloud-db.sql" | tr -d ' ')" >> "$RESTIC_LOG"; done ;; esac
exit 0
"""


@unittest.skipUnless(SCRIPT.exists(), 'private operator script (not in the public source export)')
class SystemBackupTests(unittest.TestCase):
    def run_backup(self, dump):
        temp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        bin_dir, srv = temp / 'bin', temp / 'srv'
        for d in (bin_dir, srv / 'forgejo/backups/fj-20260101T000000Z', srv / 'forgejo/backups/hourly', srv / 'qoopia/backups/verified-20260101T000000Z',
                  srv / 'qoopia/backups/incoming-20260102T000000Z', srv / 'qoopia/config', srv / 'qoopia/releases/abc', srv / 'qoopia-monitor', srv / 'backup-system'):
            d.mkdir(parents=True)
        (srv / 'forgejo/backups/fj-20260101T000000Z/COMPLETE').write_text('')
        (srv / 'qoopia/.env').write_text('X=1\n')
        os.symlink('releases/abc', srv / 'qoopia/current')
        (srv / 'qoopia-monitor/sqlite-snapshot-tree.py').write_text('raise SystemExit(0)\n')
        for name, body in [('docker', DOCKER), ('restic', RESTIC), ('crontab', '#!/bin/bash\nexit 0\n')]:
            (bin_dir / name).write_text(body)
            os.chmod(bin_dir / name, 0o755)
        env = {**os.environ, 'PATH': '%s:%s' % (bin_dir, os.environ['PATH']), 'SRV': str(srv), 'DUMP': dump, 'RESTIC_LOG': str(temp / 'restic.log')}
        run = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
        return run, (temp / 'restic.log').read_text().splitlines(), srv

    def test_a_failed_database_dump_fails_the_backup_and_no_empty_dump_is_stored(self):
        run, asked, srv = self.run_backup('fail')
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('FAIL nextcloud db dump', run.stdout)
        self.assertFalse([line for line in asked if line.startswith('dump-bytes=')])
        self.assertFalse((srv / 'backup-system/stage/nextcloud-db.sql').exists())

    def test_the_snapshot_holds_the_dump_the_configuration_and_only_a_verified_memory_backup(self):
        run, asked, srv = self.run_backup('ok')
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('dump-bytes=19', asked)
        for path in ('qoopia/.env', 'qoopia/config', 'qoopia/backups/verified-20260101T000000Z'):
            self.assertIn(str(srv / path), asked)
        self.assertIn(os.path.realpath(srv / 'qoopia/releases/abc'), asked)
        self.assertFalse([line for line in asked if 'incoming-' in line or line.endswith('/qoopia/secrets')])


if __name__ == '__main__':
    unittest.main()
