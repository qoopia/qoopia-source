import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('metadata', root / 'scripts/check-release-metadata.py')
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class MetadataGateTests(unittest.TestCase):
    def test_published_metadata_and_version_bump_without_delivery(self):
        self.assertEqual(metadata.check(root), [])
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            for path in ['package.json', 'CHANGELOG.md', 'marketing-site/release.json', 'marketing-site/ios-release.json', 'marketing-site/updates/macos/appcast.xml', 'marketing-site/releases.html', 'ios/Qoopia.xcodeproj/project.pbxproj']:
                destination = fixture / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / path, destination)
            shutil.copytree(root / 'migrations', fixture / 'migrations')
            package = json.loads((fixture / 'package.json').read_text())
            package['version'] = '99.0.0'
            (fixture / 'package.json').write_text(json.dumps(package))
            issues = metadata.check(fixture)
            self.assertIn('release:version_mismatch', issues)
            self.assertIn('appcast:package_mismatch', issues)
            self.assertIn('website:missing_release_notes', issues)


if __name__ == '__main__':
    unittest.main()
