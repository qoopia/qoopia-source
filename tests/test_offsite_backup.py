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
import time
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
                  [ -z "${MEMORY_BYTES:-}" ] || head -c "$MEMORY_BYTES" /dev/zero >> "$out"
                  printf '{"sha256":"%s"}' "$(sha256sum "$out" | cut -d' ' -f1)" ;;
  *v4-rollback-rehearsal.ts*) echo '{"rto_pass":true}' ;;
esac
'''
# ssh/scp against a local directory per host; the remote command runs in that "home". The real targets are
# Macs whose login shell is zsh, which does not expand a pattern held in a variable: -f (no globbing at all)
# proves the remote commands need none.
SSH = r'''#!/bin/bash
while [[ "$1" == -* ]]; do [[ "$1" == -i || "$1" == -o ]] && shift; shift; done
host=$1; shift; [ "$host" = "${OFFLINE_HOST:-}" ] && exit 255; mkdir -p "$FAKE_HOMES/$host"; cd "$FAKE_HOMES/$host" && bash -f -c "$*"
'''
SCP = r'''#!/bin/bash
while [[ "$1" == -* ]]; do [[ "$1" == -i || "$1" == -o ]] && shift; shift; done
dest=$2; host=${dest%%:*}; mkdir -p "$FAKE_HOMES/$host"; cp "$1" "$FAKE_HOMES/$host/${dest#*:}"
'''
# Records the limit each copy was given, then runs the copy.
TIMEOUT = r'''#!/bin/bash
echo "$1 ${*: -2:1}" >> "$TIMEOUT_LOG"; shift; exec "$@"
'''


@unittest.skipUnless(SCRIPT.exists(), 'private operator script (not in the public source export)')
class OffsiteBackupTests(unittest.TestCase):
    def test_memory_and_sign_in_reach_every_target(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            bin_dir, root, auth = temp / 'bin', temp / 'qoopia', temp / 'auth'
            for d in (bin_dir, root / 'logs', root / 'backups', auth):
                d.mkdir(parents=True)
            for name, body in [('docker', DOCKER), ('ssh', SSH), ('scp', SCP), ('timeout', TIMEOUT)]:
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
                   'AUTH_DATA': str(auth), 'HOUSEKEEPING': str(REPO / 'scripts/ops-housekeeping.py'), 'OFFSITE_HOSTS': 'owner@mini owner@book', 'OFFSITE_KEY': '/dev/null', 'TIMEOUT_LOG': str(temp / 'timeouts')}
            # Twenty older copies of each file already wait on one target: retention must prune them there.
            old_home = temp / 'homes' / 'owner@mini' / 'qoopia-offsite'
            old_home.mkdir(parents=True)
            for day in range(1, 21):
                for name in ('qoopia-202601%02dT000000Z.db', 'auth-login-202601%02dT000000Z.sqlite', 'auth-analytics-202601%02dT000000Z.sqlite'):
                    old = old_home / (name % day)
                    old.write_text('old')
                    os.utime(old, (86400 * day, 86400 * day))
            # What an interrupted copy of an earlier day left behind: not a backup, removed by the next run.
            (old_home / 'qoopia-20260101T000000Z.db.part').write_text('half')
            started = [0]

            def script(env):
                # The script names its folder and files by the second: two runs in one second would share them.
                time.sleep(max(0, started[0] + 1 - time.time()))
                started[0] = int(time.time())
                return subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
            run = script({**env, 'MEMORY_BYTES': str(9 * 1024 * 1024)})
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(list(old_home.glob('*.part')), [])
            # The copy limit grows with the file, a second for every 4 MB: 180 s cut a 2.4 GB copy on a slow link.
            limits = {os.path.basename(line.split()[1]): line.split()[0] for line in (temp / 'timeouts').read_text().splitlines()}
            self.assertEqual(limits, {'qoopia.db': '182', 'auth-login.sqlite': '180', 'auth-analytics.sqlite': '180'})
            for pattern in ('qoopia-2*.db', 'auth-login-2*.sqlite', 'auth-analytics-2*.sqlite'):
                kept = sorted(p.name for p in old_home.glob(pattern))
                self.assertEqual(len(kept), 14, kept)  # KEEP: the new copy and the thirteen newest old ones
                self.assertFalse(any('202601%02dT' % day in name for name in kept for day in range(1, 8)), kept)
            for old in old_home.glob('*-202601*'):
                old.unlink()
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

            # Sleeping optional laptop cannot fail the mandatory daily copy.
            optional_env = {**env, 'OFFSITE_HOSTS': 'owner@mini', 'OFFSITE_OPTIONAL_HOSTS': 'owner@book', 'OFFLINE_HOST': 'owner@book'}
            run = script(optional_env)
            self.assertEqual(run.returncode, 0, run.stderr)
            record = json.loads(log.read_text().splitlines()[-1])
            self.assertEqual(record['failed_optional_hosts'], ['owner@book'])
            self.assertEqual(record['successful_hosts'], ['owner@mini'])
            now = datetime.datetime.now(datetime.timezone.utc)
            self.assertEqual(health.offsite_issues(str(log), now), [])
            records = [json.loads(line) for line in log.read_text().splitlines()]
            for r in records:
                if r.get('host') == 'owner@book' and r.get('optional'):
                    r['at'] = (now - datetime.timedelta(days=8)).isoformat()
            log.write_text(''.join(json.dumps(r) + '\n' for r in records))
            self.assertEqual(health.offsite_issues(str(log), now), ['backup:optional_offsite_stale:owner@book'])
            # A verified copy clears the overdue optional-target warning.
            optional_env.pop('OFFLINE_HOST')
            run = script(optional_env)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(health.offsite_issues(str(log), datetime.datetime.now(datetime.timezone.utc)), [])

            # An interrupted copy never appears under a backup's name, where retention would count it and a
            # restore would take it: it stays *.part until its hash has matched on the far side.
            shutil.rmtree(temp / 'homes')
            (bin_dir / 'scp').write_text(SCP.replace('cp "$1" ', 'head -c 3 "$1" > ').replace('"$FAKE_HOMES/$host/${dest#*:}"', '"$FAKE_HOMES/$host/${dest#*:}"; exit 1'))
            run = script(env)
            self.assertNotEqual(run.returncode, 0)
            record = json.loads(log.read_text().splitlines()[-1])
            self.assertEqual((record['step'], record['detail']), ('offsite', 'owner@mini: transfer'))
            self.assertEqual([p.suffix for p in (temp / 'homes/owner@mini/qoopia-offsite').iterdir()], ['.part'])
            (bin_dir / 'scp').write_text(SCP)
            (temp / 'timeouts').unlink()
            run = script({**env, 'OFFSITE_COPY_TIMEOUT_SEC': '7'})
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual({line.split()[0] for line in (temp / 'timeouts').read_text().splitlines()}, {'7'})  # the override still wins

            # A target that silently loses the bytes fails the run, and the failure is recorded. The copies
            # of the first run go first: its file names carry the same second when both runs share one.
            shutil.rmtree(temp / 'homes')
            (bin_dir / 'scp').write_text('#!/bin/bash\nexit 0\n')
            run = script(env)
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(json.loads(log.read_text().splitlines()[-1])['status'], 'fail')

            # A run that fails before its checks pass leaves no folder named verified-*: the system backup takes
            # the newest one, and used to take the empty or partial folder of the failed run.
            before = sorted(p.name for p in (root / 'backups').iterdir())
            (bin_dir / 'docker').write_text(DOCKER.replace("echo '{\"rto_pass\":true}'", "echo 'restore failed' >&2; exit 1"))
            run = script(env)
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(json.loads(log.read_text().splitlines()[-1])['step'], 'rehearsal')
            self.assertEqual(sorted(p.name for p in (root / 'backups').iterdir()), before)
            self.assertTrue(all((root / 'backups' / name / 'qoopia.db').is_file() for name in before))


if __name__ == '__main__':
    unittest.main()
