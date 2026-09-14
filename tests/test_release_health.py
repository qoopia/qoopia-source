import datetime
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_health', Path(__file__).resolve().parents[1] / 'scripts/release-health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class ReleaseHealthTests(unittest.TestCase):
    def test_missing_failed_and_stale_sources_are_not_healthy(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        rows = [{'source': s, 'status': 'ok', 'finished_at': now.isoformat()} for s in health.CORE]
        self.assertEqual(health.analytics_issues({'source_runs': rows}, now), [])
        rows[0]['status'] = 'error'
        rows[1]['finished_at'] = (now - datetime.timedelta(minutes=16)).isoformat()
        missing = rows.pop()['source']
        self.assertEqual(set(health.analytics_issues({'source_runs': rows}, now)), {'analytics:' + rows[0]['source'], 'analytics_stale:' + rows[1]['source'], 'analytics:' + missing})

    def test_http_failure_never_exposes_response(self):
        with patch.object(health.subprocess, 'run', return_value=subprocess.CompletedProcess([], 22, b'private response', b'secret URL')):
            _, result = health.request(('auth', 'https://example.invalid'))
        self.assertFalse(result['ok'])
        self.assertNotIn('private', str(result))
        self.assertNotIn('secret', str(result))

    def test_invalid_json_shape_is_failure(self):
        for body in [b'[]', b'not JSON', b'null']:
            with self.subTest(body=body), patch.object(health.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, body, b'')):
                self.assertFalse(health.request(('auth', 'https://example.invalid'))[1]['ok'])

    def test_timeout_is_failure(self):
        with patch.object(health.subprocess, 'run', side_effect=subprocess.TimeoutExpired('curl', 15)):
            self.assertFalse(health.request(('release', 'https://example.invalid'))[1]['ok'])


if __name__ == '__main__':
    unittest.main()
