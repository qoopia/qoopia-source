import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('ops_housekeeping', Path(__file__).resolve().parents[1] / 'scripts/ops-housekeeping.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class HousekeepingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_snapshot_of_a_live_wal_database_is_complete_and_self_contained(self):
        live = self.root / 'login.sqlite'
        writer = sqlite3.connect(live)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute('CREATE TABLE accounts(id INTEGER PRIMARY KEY, email TEXT)')
        writer.executemany('INSERT INTO accounts(email) VALUES (?)', [('user%d@example.test' % i,) for i in range(500)])
        writer.commit()
        self.assertGreater((self.root / 'login.sqlite-wal').stat().st_size, 0)  # committed rows live only in the WAL
        writer.execute('BEGIN IMMEDIATE')  # an open writer must not block the copy
        writer.execute("INSERT INTO accounts(email) VALUES ('uncommitted@example.test')")
        result = ops.snapshot(live, self.root / 'out' / 'login.sqlite')
        writer.rollback()
        writer.close()
        copy = self.root / 'out' / 'login.sqlite'
        self.assertEqual(sorted(p.name for p in copy.parent.iterdir()), ['login.sqlite'])
        self.assertEqual(stat.S_IMODE(copy.stat().st_mode), 0o600)
        self.assertEqual(result['bytes'], copy.stat().st_size)
        db = sqlite3.connect('file:%s?mode=ro&immutable=1' % copy, uri=True)
        self.assertEqual(db.execute('SELECT count(*) FROM accounts').fetchone()[0], 500)
        self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        db.close()

    def test_private_strips_group_and_other_bits(self):
        tree = self.root / 'deadman'
        (tree / 'sub').mkdir(parents=True)
        log, ledger, script = tree / 'observer.log', tree / 'sub' / 'ledger.sqlite3', tree / 'run.py'
        for f, mode in [(log, 0o644), (ledger, 0o664), (script, 0o755)]:
            f.write_text('x')
            os.chmod(f, mode)
        os.chmod(tree, 0o755)
        os.chmod(tree / "sub", 0o755)
        dry = ops.private([tree], apply=False)
        self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o644)
        self.assertEqual(len(dry), 5)
        ops.private([tree, self.root / 'absent'], apply=True)
        self.assertEqual([oct(stat.S_IMODE(p.stat().st_mode)) for p in (tree, tree / 'sub', log, ledger, script)], ['0o700', '0o700', '0o600', '0o600', '0o700'])
        self.assertEqual(ops.private([tree], apply=True), [])

    def test_prune_keeps_newest_young_and_protected(self):
        now = time.time()
        for name, days in [('pre-release-513', 40), ('pre-release-514', 35), ('pre-release-519', 5), ('pre-release-520', 3), ('pre-release-512', 50), ('current-public', 60), ('notes.txt', 90)]:
            path = self.root / name
            path.mkdir() if name.startswith(('pre-', 'current')) else path.write_text('x')
            os.utime(path, (now - days * 86400,) * 2)
        plan = ops.prune(self.root, ['pre-*', 'current-*'], keep=2, max_age_days=30, protect=['current-public'], now=now)
        self.assertEqual(plan, ['pre-release-514', 'pre-release-513', 'pre-release-512'])
        self.assertTrue((self.root / 'pre-release-512').exists())  # dry run
        ops.prune(self.root, ['pre-*', 'current-*'], keep=2, max_age_days=30, protect=['current-public'], apply=True, now=now)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['current-public', 'notes.txt', 'pre-release-519', 'pre-release-520'])

    def test_cli_reports_json(self):
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ops.main(['private', str(self.root)])
        self.assertEqual(json.loads(out.getvalue())['applied'], False)


if __name__ == '__main__':
    unittest.main()
