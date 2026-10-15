"""deploy/qoopia-offsite-backup.sh end to end with stub docker/ssh/scp: memory and sign-in copies land on
every target with matching hashes, and the jsonl record is what release-health requires."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / 'deploy/qoopia-offsite-backup.sh'
spec = importlib.util.spec_from_file_location('release_health', REPO / 'scripts/release-health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

DOCKER = r'''#!/bin/bash
# docker exec <container> <cmd...>: just enough of v4-backup, rehearsal and printenv.
shift 2
case "$*" in
  printenv*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  *v4-backup.ts*) out=$(printf '%s\n' "$@" | grep -A1 -- --output | tail -1); printf 'memory' > "$out"
                  printf '{"sha256":"%s"}' "$(sha256sum "$out" | cut -d' ' -f1)" ;;
  *v4-rollback-rehearsal.ts*) echo '{"rto_pass":true}' ;;
esac
'''
# ssh/scp against a local directory per host; the remote command runs in that "home".
SSH = r'''#!/bin/bash
while [[ "$1" == -* ]]; do [[ "$1" == -i || "$1" == -o ]] && shift; shift; done
host=$1; shift; mkdir -p "$FAKE_HOMES/$host"; cd "$FAKE_HOMES/$host" && bash -c "$*"
'''
SCP = r'''#!/bin/bash
while [[ "$1" == -* ]]; do [[ "$1" == -i || "$1" == -o ]] && shift; shift; done
dest=$2; host=${dest%%:*}; mkdir -p "$FAKE_HOMES/$host"; cp "$1" "$FAKE_HOMES/$host/${dest#*:}"
'''


@unittest.skipUnless(SCRIPT.exists(), 'private operator script (not in the public source export)')
class OffsiteBackupTests(unittest.TestCase):
    def test_memory_and_sign_in_reach_every_target(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            bin_dir, root, auth = temp / 'bin', temp / 'qoopia', temp / 'auth'
            for d in (bin_dir, root / 'logs', root / 'backups', auth):
                d.mkdir(parents=True)
            for name, body in [('docker', DOCKER), ('ssh', SSH), ('scp', SCP)]:
                (bin_dir / name).write_text(body)
                os.chmod(bin_dir / name, 0o755)
            for db in ('login', 'analytics'):
                c = sqlite3.connect(auth / (db + '.sqlite'))
                c.execute('PRAGMA journal_mode=WAL')
                c.execute('PRAGMA wal_autocheckpoint=0')
                c.execute('CREATE TABLE t(x)')
                c.executemany('INSERT INTO t VALUES (?)', [(i,) for i in range(100)])
                c.commit()
                c.close()
            env = {**os.environ, 'PATH': '%s:%s' % (bin_dir, os.environ['PATH']), 'FAKE_HOMES': str(temp / 'homes'), 'QOOPIA_ROOT': str(root),
                   'AUTH_DATA': str(auth), 'HOUSEKEEPING': str(REPO / 'scripts/ops-housekeeping.py'), 'OFFSITE_HOSTS': 'owner@mini owner@book', 'OFFSITE_KEY': '/dev/null'}
            run = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(run.returncode, 0, run.stderr)
            log = root / 'logs/offsite-backup.jsonl'
            record = json.loads(log.read_text().splitlines()[-1])
            self.assertEqual((record['status'], record['auth']), ('ok', 'ok'))
            for host in ('owner@mini', 'owner@book'):
                remote = temp / 'homes' / host / 'qoopia-offsite'
                self.assertEqual(sorted(p.name.split('-2')[0] for p in remote.iterdir()), ['auth-analytics', 'auth-login', 'qoopia'])
                login = sqlite3.connect(next(remote.glob('auth-login-*.sqlite')))
                self.assertEqual(login.execute('SELECT count(*) FROM t').fetchone()[0], 100)
                login.close()
            self.assertEqual(health.offsite_issues(str(log), datetime.datetime.now(datetime.timezone.utc)), [])

            # A target that silently loses the bytes fails the run, and the failure is recorded. The copies
            # of the first run go first: its file names carry the same second when both runs share one.
            shutil.rmtree(temp / 'homes')
            (bin_dir / 'scp').write_text('#!/bin/bash\nexit 0\n')
            run = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(json.loads(log.read_text().splitlines()[-1])['status'], 'fail')


if __name__ == '__main__':
    unittest.main()
