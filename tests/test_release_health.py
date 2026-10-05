import base64
import datetime
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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

    def test_structured_not_ready_names_the_failed_check(self):
        body = b'{"status":"not_ready","checks":{"schema_version":"ok","storage":"degraded","Odd Key<script>":"bad"}}'
        with patch.object(health.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, body + b'\n503', b'')):
            name, result = health.request(('memory', 'https://example.invalid/ready'))
        self.assertEqual(result, {'ok': False, 'error': 'NOT_READY', 'failed_checks': ['storage']})
        self.assertEqual(health.request_issues({name: result, 'auth': {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'}}), ['memory:not_ready:storage', 'auth'])
        self.assertEqual(health.request_issues({'review': {'ok': False, 'error': 'NOT_READY', 'failed_checks': []}}), ['review:not_ready:unknown'])

    def test_readiness_without_the_not_ready_shape_stays_a_generic_failure(self):
        for body, code in [(b'<html>Cloudflare 503</html>', b'503'), (b'{"status":"not_ready"}', b'503'), (b'private response', b'502')]:
            with self.subTest(code=code), patch.object(health.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, body + b'\n' + code, b'')):
                result = health.request(('memory', 'https://example.invalid/ready'))[1]
            self.assertEqual(result, {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'})
        with patch.object(health.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'{"status":"ready"}\n200', b'')):
            self.assertEqual(health.request(('review', 'https://example.invalid/ready'))[1]['data'], {'status': 'ready'})

    def test_timeout_is_failure(self):
        with patch.object(health.subprocess, 'run', side_effect=subprocess.TimeoutExpired('curl', 15)):
            self.assertFalse(health.request(('release', 'https://example.invalid'))[1]['ok'])

    def test_expected_schema_is_required_and_validated(self):
        self.assertEqual(health.expected_schema('45'), 45)
        for value in [None, '', '0', '-1', 'latest', '4.5']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                health.expected_schema(value)

    def test_missing_schema_is_a_configuration_error_before_any_request(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/release-health.py'
        env = {k: v for k, v in os.environ.items() if k != 'QOOPIA_SCHEMA_VERSION'}
        with tempfile.TemporaryDirectory() as root:
            run = subprocess.run([sys.executable, str(script), '--root', root, '--source', 'a' * 40], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 2)
            self.assertIn('Expected schema is not configured', run.stderr)
            self.assertEqual(os.listdir(root), [])


class ReleaseConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.data = {
            name: {'version': '5.0.9'} for name in
            ('release', 'auth', 'memory', 'public_package', 'public_release')
        }
        self.data['release'].update(tag='v5.0.9', schema_version=46, packages={'mac': {'url': 'https://example.test/app.dmg', 'bytes': 123, 'requirements': 'Apple Silicon Mac, macOS 15.0 or newer.'}})
        self.data['public_release'].update(package_source='a' * 40, schema_version=46)
        self.data.update(
            downloads_tag='https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.9',
            source_tag='https://github.com/qoopia/qoopia-source/releases/tag/v5.0.9',
            appcast='<rss xmlns:s="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><s:version>1790000000</s:version><s:shortVersionString>5.0.9</s:shortVersionString><s:minimumSystemVersion>15.0</s:minimumSystemVersion><enclosure url="https://example.test/app.dmg" length="123" s:edSignature="' + 'A' * 86 + '=="/></item></channel></rss>',
            ios={'version': '5.0.8', 'build': '3', 'status': 'review'})

    def issues(self):
        return health.consistency_issues(self.data, '5.0.9', 46, 'a' * 40, '5.0.8', '3')

    def test_explicit_separate_beta_and_independent_sources_are_allowed(self):
        self.data['memory']['release_sha'] = 'b' * 40
        self.assertEqual(self.issues(), [])

    def test_actual_split_release_cannot_be_green(self):
        self.data['auth']['version'] = self.data['memory']['version'] = '5.0.8'
        self.data['public_package']['version'] = '5.0.4'
        self.assertEqual(set(self.issues()), {'auth:version_mismatch', 'memory:version_mismatch', 'public_package:version_mismatch'})

    def test_appcast_stale_or_wrong_package_fails(self):
        for old, new in [('5.0.9', '5.0.8'), ('123', '124'), ('app.dmg', 'other.dmg')]:
            with self.subTest(old=old):
                original = self.data['appcast']
                self.data['appcast'] = original.replace(old, new)
                self.assertIn('appcast:package_mismatch', self.issues())
                self.data['appcast'] = original

    def test_appcast_an_installed_app_would_skip_fails(self):
        for old, new in [('<s:version>1790000000', '<s:version>'), (' s:edSignature="' + 'A' * 86 + '=="', ''), ('>15.0<', '>26.0<')]:
            with self.subTest(old=old):
                original = self.data['appcast']
                self.data['appcast'] = original.replace(old, new)
                self.assertEqual(self.issues(), ['appcast:not_installable'])
                self.data['appcast'] = original

    def test_schema_and_provenance_are_not_just_version_labels(self):
        self.data['release']['schema_version'] = 45
        self.data['public_release']['package_source'] = 'c' * 40
        self.assertEqual(set(self.issues()), {'release:identity_mismatch', 'public_release:provenance_mismatch'})

    def test_github_stale_latest_release_fails(self):
        self.data['source_tag'] = self.data['source_tag'].replace('5.0.9', '5.0.4')
        self.assertIn('source_tag:version_mismatch', self.issues())

    def test_ios_review_is_not_public_availability(self):
        self.data['ios']['status'] = 'available'
        self.assertIn('ios:missing_public_invitation', self.issues())
        self.data['ios'].update(public_url='https://testflight.apple.com/join/example', build='4')
        self.assertIn('ios:unexpected_channel_state', self.issues())

    def test_malformed_appcast_is_reported(self):
        self.data['appcast'] = '<broken'
        self.assertIn('appcast:invalid', self.issues())

    def test_nested_invalid_package_is_reported(self):
        self.data['release']['packages'] = []
        self.assertIn('appcast:invalid', self.issues())

    def test_unmonitored_mirrors_can_no_longer_hide_stale_versions(self):
        for name in ('public_main', 'downloads_release', 'pages_release', 'review'):
            with self.subTest(name=name):
                self.data[name] = {'version': '5.0.4'}
                self.assertIn(name + ':version_mismatch', self.issues())
                del self.data[name]

    def test_downloads_copy_distinguishes_current_claim_from_upgrade_history(self):
        self.data['downloads_readme'] = '# Qoopia\nDownload the latest Qoopia\nQoopia 5.0.1 and newer support updates.'
        self.assertEqual(self.issues(), [])
        self.data['downloads_readme'] = '# Qoopia 5.0.4\n'
        self.assertIn('downloads_readme:stale_version', self.issues())

    def test_review_must_be_ready_and_match_schema(self):
        self.data['review'] = {'version': '5.0.9', 'status': 'starting', 'schema_version': 45}
        self.assertIn('review:unexpected_state', self.issues())


class MirrorTests(unittest.TestCase):
    def test_mirror_compares_fresh_remote_head_and_product_version(self):
        for remote, version, expected in [('a', '5.0.9', []), ('b', '5.0.9', ['git_mirror:stale_main']), ('a', '5.0.4', ['git_mirror:version_mismatch'])]:
            receipt = '{"status":"OK","checked_at":100,"remote_main":"' + remote + '"}'
            with self.subTest(remote=remote, version=version), patch.object(health.subprocess, 'check_output', side_effect=['a', '{"version":"' + version + '"}']), patch.object(health.Path, 'read_text', return_value=receipt), patch.object(health.time, 'time', return_value=101):
                self.assertEqual(health.mirror_issues('/example', '5.0.9'), expected)

    def test_stale_sync_cannot_look_healthy(self):
        with patch.object(health.subprocess, 'check_output', return_value='a'), patch.object(health.Path, 'read_text', return_value='{"status":"OK","checked_at":100}'), patch.object(health.time, 'time', return_value=701):
            self.assertEqual(health.mirror_issues('/example', '5.0.9'), ['git_mirror:sync_stale_or_failed'])

    def test_unreachable_mirror_does_not_expose_git_error(self):
        with patch.object(health.subprocess, 'check_output', side_effect=subprocess.CalledProcessError(128, ['git'])):
            self.assertEqual(health.mirror_issues('/example', '5.0.9'), ['git_mirror:unavailable'])


class AlertDeliveryTests(unittest.TestCase):
    KEY = bytes(range(32))

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='qoopia-health-alert-')
        self.addCleanup(lambda: __import__('shutil').rmtree(self.root, ignore_errors=True))
        self.channels = os.path.join(self.root, 'channels.json')
        policy = {'format': 'qoopia-alert-channels/1', 'channels': [{'id': 'owner', 'url': 'https://alerts.example.test/qoopia', 'allowed_hosts': ['alerts.example.test'], 'signing_key_base64url': base64.urlsafe_b64encode(self.KEY).rstrip(b'=').decode()}]}
        with open(os.open(self.channels, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
            json.dump(policy, f)
        self.sent = []

    def receiver(self, accept=True):
        def run(args, input=None, **_):
            self.assertEqual(args[0], 'curl')
            self.assertIn('=https', args)
            signature = 'sha256=' + base64.urlsafe_b64encode(hmac.new(self.KEY, input, hashlib.sha256).digest()).rstrip(b'=').decode()
            self.assertIn('x-qoopia-signature: ' + signature, args)
            event = json.loads(input)
            self.sent.append(event)
            receipt = {'accepted': True, 'event_id': event['id'], 'payload_sha256': hashlib.sha256(input).hexdigest()} if accept else {}
            return subprocess.CompletedProcess(args, 0, json.dumps(receipt).encode(), b'')
        return run

    def run_main(self, channels, receiver, auth=None, extra=()):
        argv = ['release-health.py', '--root', self.root, '--source', 'a' * 40, '--schema-version', '47', '--version', '5.0.14', '--ios-version', '5.0.8', '--ios-build', '3',
                '--analytics', os.path.join(self.root, 'none.json'), '--git-mirror', os.path.join(self.root, 'none'), '--alert-channels', channels, *extra]

        def request(item):
            if item[0] == 'auth' and auth is not None:
                return 'auth', {'ok': True, 'data': auth}
            return item[0], {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'}
        with patch.object(sys, 'argv', argv), patch.object(health, 'request', request), \
                patch.object(health, 'mirror_issues', return_value=[]), patch.object(health.subprocess, 'run', side_effect=receiver), patch('builtins.print'):
            code = health.main()
        return code, json.loads(Path(self.root, 'status.json').read_text())

    def test_sign_in_service_must_report_the_expected_release_sha(self):
        good = {'version': '5.0.14', 'ready': True, 'release_sha': 'a' * 40}
        issues = lambda auth, extra=(): self.run_main('', None, auth, extra)[1]['issues']
        self.assertNotIn('auth:unexpected_state', issues(good))
        self.assertIn('auth:unexpected_state', issues({**good, 'release_sha': 'b' * 40}))
        self.assertIn('auth:unexpected_state', issues({'version': '5.0.14', 'ready': True}))
        self.assertNotIn('auth:unexpected_state', issues({**good, 'release_sha': 'b' * 40}, ('--auth-source', 'b' * 40)))

    def test_alert_transition_reaches_owner_channel_once(self):
        code, status = self.run_main(self.channels, self.receiver())
        self.assertEqual(code, 1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]['event_type'], 'operational_alert')
        self.assertEqual(self.sent[0]['payload']['subject'], 'ALERT')
        self.assertEqual(status['alert']['state'], 'delivered')
        self.run_main(self.channels, self.receiver())
        self.assertEqual(len(self.sent), 1)

    def test_failed_delivery_is_visible_and_retried(self):
        code, status = self.run_main(self.channels, self.receiver(accept=False))
        self.assertEqual(code, 1)
        self.assertEqual(status['alert']['state'], 'failed')
        code, status = self.run_main(self.channels, self.receiver())
        self.assertEqual(status['alert']['state'], 'delivered')
        self.assertEqual([e['id'] for e in self.sent], [self.sent[0]['id']] * 2)

    def test_unconfigured_monitor_sends_nothing(self):
        def forbidden(*_a, **_k):
            raise AssertionError('no channel configured')
        _, status = self.run_main('', forbidden)
        self.assertEqual(status['alert']['state'], 'not_configured')


if __name__ == '__main__':
    unittest.main()
