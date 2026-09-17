from contextlib import closing
import datetime as dt
import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('cycle', Path(__file__).resolve().parents[1] / 'scripts/discovery-cycle.py')
cycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cycle)


class DailyCycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.now = dt.datetime(2026, 9, 16, 13, tzinfo=dt.timezone.utc)

    def evidence(self, status='OBSERVED'):
        state = cycle.read(self.root / 'daily-state.json')
        output = Path(state['evidence'])
        cycle.write(output / 'technical.json', {'observed_at': self.now.isoformat(), 'results': {'home': {}}, 'status': 'TECHNICAL_CHECKS_PASS'})
        (self.root / 'visibility').mkdir(exist_ok=True)
        with closing(sqlite3.connect(self.root / 'visibility/observations.sqlite')) as db, db:
            db.execute('CREATE TABLE observations (observed_at TEXT, body TEXT)')
            for source in cycle.REQUIRED:
                p = output / (source + '.txt')
                p.write_text('Synthetic test evidence')
                r = {'source': source, 'status': status, 'observed_at': self.now.isoformat(), 'evidence': str(p), 'evidence_sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                db.execute('INSERT INTO observations VALUES (?, ?)', (r['observed_at'], json.dumps(r)))

    def test_lease_and_bounded_recovery(self):
        self.assertEqual(cycle.begin(self.root, self.now)['action'], 'RUN')
        self.assertEqual(cycle.begin(self.root, self.now)['action'], 'IN_PROGRESS')
        later = self.now + dt.timedelta(hours=2)
        self.assertEqual(cycle.begin(self.root, later)['state']['attempt'], 2)
        self.assertEqual(cycle.begin(self.root, later + dt.timedelta(hours=2))['action'], 'RECOVERY_EXHAUSTED')

    def test_missing_source_cannot_complete(self):
        cycle.begin(self.root, self.now)
        self.evidence()
        with closing(sqlite3.connect(self.root / 'visibility/observations.sqlite')) as db, db:
            db.execute("DELETE FROM observations WHERE body LIKE '%claude-consumer%'")
        with self.assertRaisesRegex(ValueError, 'Fresh observations'):
            cycle.finish(self.root, self.now, 'NO_CHANGE', 'Reviewed')
        self.assertEqual(cycle.read(self.root / 'daily-state.json')['status'], 'STARTED')

    def test_tampering_rejected(self):
        state = cycle.begin(self.root, self.now)['state']
        self.evidence()
        (Path(state['evidence']) / 'claude-consumer.txt').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'altered evidence'):
            cycle.finish(self.root, self.now, 'NO_CHANGE', 'Reviewed')

    def test_missing_access_is_not_success(self):
        cycle.begin(self.root, self.now)
        self.evidence('BLOCKED')
        result = cycle.finish(self.root, self.now, 'NO_CHANGE', 'No access; no fabricated metrics')
        self.assertEqual(result['status'], 'COMPLETED_WITH_GAPS')
        self.assertEqual(cycle.begin(self.root, self.now)['action'], 'ALREADY_DONE')

    def test_complete_once_and_stale_observations_rejected(self):
        cycle.begin(self.root, self.now)
        self.evidence()
        self.assertEqual(cycle.finish(self.root, self.now, 'NO_CHANGE', 'Reviewed')['status'], 'COMPLETED_WITH_GAPS')
        next_day = self.now + dt.timedelta(days=1)
        cycle.begin(self.root, next_day)
        state = cycle.read(self.root / 'daily-state.json')
        cycle.write(Path(state['evidence']) / 'technical.json', {'observed_at': next_day.isoformat(), 'results': {'home': {}}, 'status': 'TECHNICAL_CHECKS_PASS'})
        with self.assertRaisesRegex(ValueError, 'Fresh observations'):
            cycle.finish(self.root, next_day, 'NO_CHANGE', 'Reviewed')


if __name__ == '__main__':
    unittest.main()
