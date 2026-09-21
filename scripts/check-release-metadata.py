#!/usr/bin/env python3
"""Offline publication gate. Live service/source checks are in release-health.py."""
import importlib.util
import json
from pathlib import Path
import re
import plistlib

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_health', root / 'scripts/release-health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

def check(root):
    def read(path):
        return json.loads((root / path).read_text())
    package = read('package.json')
    release = read('marketing-site/release.json')
    ios = read('marketing-site/ios-release.json')
    schema = max(int(p.name.split('-')[0]) for p in (root / 'migrations').glob('[0-9]*-*.sql'))
    issues = health.consistency_issues({'release': release, 'appcast': (root / 'marketing-site/updates/macos/appcast.xml').read_text(), 'ios': ios}, package['version'], schema, release['source'], ios['version'], str(ios['build']))
    for name in ('mac', 'linux'):
        item = release.get('packages', {}).get(name, {})
        if not item.get('url', '').startswith('https://github.com/qoopia/qoopia-downloads/releases/download/' + release['tag'] + '/') or package['version'] not in item.get('file', '') or not re.fullmatch('[0-9a-f]{64}', item.get('sha256', '')) or not isinstance(item.get('bytes'), int) or item.get('bytes', 0) <= 0:
            issues.append(name + ':invalid_package')
    if not re.fullmatch('[0-9a-f]{40}', release.get('source', '')):
        issues.append('release:invalid_source')
    if '## ' + package['version'] not in (root / 'CHANGELOG.md').read_text():
        issues.append('changelog:missing_version')
    if 'data-release-version="' + package['version'] + '"' not in (root / 'marketing-site/releases.html').read_text():
        issues.append('website:missing_release_notes')
    project = plistlib.loads((root / 'ios/Qoopia.xcodeproj/project.pbxproj').read_bytes())
    native_versions = {obj['buildSettings']['MARKETING_VERSION'] for obj in project['objects'].values() if 'MARKETING_VERSION' in obj.get('buildSettings', {})}
    if native_versions != {ios['version']}:
        issues.append('ios:source_manifest_mismatch')
    public = root / 'RELEASE.json'
    if public.exists():
        issues += health.consistency_issues({'public_package': package, 'public_release': read('RELEASE.json')}, package['version'], schema, release['source'], ios['version'], str(ios['build']))
    return issues

if __name__ == '__main__':
    issues = check(root)
    print(json.dumps({'status': 'FAIL' if issues else 'PASS', 'issues': issues}))
    raise SystemExit(bool(issues))
