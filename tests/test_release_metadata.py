import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('metadata', root / 'scripts/check-release-metadata.py')
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


def copy_release_files(fixture):
    for path in ['package.json', 'CHANGELOG.md', 'marketing-site/release.json', 'marketing-site/ios-release.json', 'marketing-site/updates/macos/appcast.xml', 'marketing-site/releases.html', 'ios/Qoopia.xcodeproj/project.pbxproj']:
        destination = fixture / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / path, destination)
    shutil.copytree(root / 'migrations', fixture / 'migrations')


class MetadataGateTests(unittest.TestCase):
    def test_owner_preview_preserves_public_delivery_and_cannot_pass_public_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            copy_release_files(fixture)
            schema = max(int(p.name.split('-')[0]) for p in (root / 'migrations').glob('[0-9]*-*.sql'))
            preview = {'format': 'qoopia-owner-preview/1', 'version': '99.0.0', 'schema_version': schema,
                       'status': 'awaiting_owner_acceptance', 'branch': 'release/99.0.0', 'base_source': 'a' * 40}
            package = json.loads((fixture / 'package.json').read_text())
            package['version'] = preview['version']
            (fixture / 'package.json').write_text(json.dumps(package))
            (fixture / 'CHANGELOG.md').write_text('## 99.0.0\nOwner preview\n')
            manifest = fixture / 'LOCAL-RELEASE.json'
            manifest.write_text(json.dumps(preview))
            self.assertEqual(metadata.check(fixture), [])
            self.assertIn('local_release:owner_acceptance_pending', metadata.check(fixture, public=True))
            for field, value in [('version', '98.0.0'), ('status', 'public'), ('schema_version', 0), ('base_source', 'bad'), ('public_version', '1.0.0')]:
                manifest.write_text(json.dumps({**preview, field: value}))
                self.assertIn('local_release:invalid_preview', metadata.check(fixture))

    def test_published_metadata_and_version_bump_without_delivery(self):
        self.assertEqual(metadata.check(root), [])
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            copy_release_files(fixture)
            package = json.loads((fixture / 'package.json').read_text())
            package['version'] = '99.0.0'
            (fixture / 'package.json').write_text(json.dumps(package))
            issues = metadata.check(fixture)
            self.assertIn('release:version_mismatch', issues)
            self.assertIn('appcast:package_mismatch', issues)
            self.assertIn('website:missing_release_notes', issues)

    def test_owner_preview_stage_rules_match_the_monitor(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            copy_release_files(fixture)
            release = json.loads((fixture / 'marketing-site/release.json').read_text())
            public = release['version']
            # The preview adds one migration after every one the branch already carries.
            schema = max(int(p.name[:3]) for p in (fixture / 'migrations').glob('[0-9][0-9][0-9]-*.sql'))
            (fixture / 'migrations' / '{:03d}-preview.sql'.format(schema + 1)).write_text('SELECT 1;\n')

            def preview(version):
                package = json.loads((fixture / 'package.json').read_text())
                (fixture / 'package.json').write_text(json.dumps({**package, 'version': version}))
                (fixture / 'CHANGELOG.md').write_text('## ' + version + '\n')
                (fixture / 'LOCAL-RELEASE.json').write_text(json.dumps({'format': 'qoopia-owner-preview/1', 'version': version, 'schema_version': schema + 1,
                                                                          'status': 'awaiting_owner_acceptance', 'branch': 'release/' + version, 'base_source': 'a' * 40}))
                return metadata.check(fixture)
            major, minor, patch = map(int, public.split('.'))
            # A preview that adds a migration is valid: the published files keep describing the public schema.
            self.assertEqual(preview('{}.{}.{}'.format(major, minor, patch + 1)), [])
            # The gate and the monitor refuse a preview that is not newer than public with one shared rule.
            self.assertEqual(preview(public), ['local_release:not_newer_than_public'])
            self.assertEqual(metadata.health.preview_stage(public, 'b' * 40, str(schema + 1), public, schema)[1], ['not_newer_than_public'])

    def test_package_link_must_name_the_exact_release_file(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            copy_release_files(fixture)
            path = fixture / 'marketing-site/release.json'
            release = json.loads(path.read_text())
            linux = release['packages']['linux']
            prefix = linux['url'].rsplit('/', 1)[0] + '/'
            for file, url in [(linux['file'].replace(release['version'], release['version'] + '9'), None), (linux['file'], prefix + 'other.tar.gz')]:
                with self.subTest(file=file, url=url):
                    path.write_text(json.dumps({**release, 'packages': {**release['packages'], 'linux': {**linux, 'file': file, 'url': url or prefix + file}}}))
                    self.assertIn('linux:invalid_package', metadata.check(fixture))

    def test_appcast_build_must_exceed_every_earlier_release(self):
        item = '<sparkle:version>{}</sparkle:version><sparkle:shortVersionString>{}</sparkle:shortVersionString>'
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            appcast = fixture / metadata.APPCAST
            appcast.parent.mkdir(parents=True)
            git = lambda *args: subprocess.run(['git', '-C', directory, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', *args], check=True, capture_output=True)
            git('init', '-q')
            appcast.write_text(item.format(1791062872, '5.0.16'))
            git('add', '.'); git('commit', '-qm', '5.0.16')
            self.assertTrue(metadata.appcast_build_is_newest(fixture, '5.0.16'))
            for build, newest in [(1791062872, False), (1700000000, False), (1791100000, True)]:
                appcast.write_text(item.format(build, '5.0.17'))
                self.assertEqual(metadata.appcast_build_is_newest(fixture, '5.0.17'), newest, build)
            git('commit', '-qam', '5.0.17')
            self.assertTrue(metadata.appcast_build_is_newest(fixture, '5.0.17'))


if __name__ == '__main__':
    unittest.main()
