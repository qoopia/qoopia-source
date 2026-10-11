#!/usr/bin/env python3
"""Offline publication gate. Live service/source checks are in release-health.py."""
import importlib.util
import json
from pathlib import Path
import re
import plistlib
import subprocess
import argparse

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_health', root / 'scripts/release-health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

APPCAST = 'marketing-site/updates/macos/appcast.xml'
BUILD = re.compile(r'<sparkle:version>(\d+)</sparkle:version><sparkle:shortVersionString>([^<]+)<')


def appcast_build_is_newest(root, version):
    """Sparkle offers an item only above the installed CFBundleVersion: every earlier release's
    committed build must be lower. Without Git history (shallow checkout) there is nothing to compare."""
    current = BUILD.search((root / APPCAST).read_text())
    try:
        history = subprocess.run(['git', '-C', str(root), 'log', '-p', '--format=', '--', APPCAST], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        history = ''
    return bool(current) and all(int(build) < int(current[1]) for build, other in BUILD.findall(history) if other != version)


def check(root, *, public=False):
    def read(path):
        return json.loads((root / path).read_text())
    package = read('package.json')
    release = read('marketing-site/release.json')
    ios = read('marketing-site/ios-release.json')
    schema = max(int(p.name.split('-')[0]) for p in (root / 'migrations').glob('[0-9]*-*.sql'))
    preview_path = root / 'LOCAL-RELEASE.json'
    preview = read('LOCAL-RELEASE.json') if preview_path.exists() else None
    # Owner acceptance precedes publication. Keep the signed public feed and download
    # hashes truthful instead of inventing unpublished packages to satisfy this gate.
    version = release['version'] if preview and not public else package['version']
    issues = health.consistency_issues({'release': release, 'appcast': (root / 'marketing-site/updates/macos/appcast.xml').read_text(), 'ios': ios}, version, schema, release['source'], ios['version'], str(ios['build']))
    if preview:
        if public:
            issues.append('local_release:owner_acceptance_pending')
        if (preview.get('format') != 'qoopia-owner-preview/1' or preview.get('version') != package['version']
                or preview.get('schema_version') != schema or preview.get('status') != 'awaiting_owner_acceptance'
                or preview.get('branch') != 'release/' + package['version']
                or not re.fullmatch('[0-9a-f]{40}', preview.get('base_source', ''))
                or tuple(map(int, package['version'].split('.'))) <= tuple(map(int, release['version'].split('.')))):
            issues.append('local_release:invalid_preview')
    for name in ('mac', 'linux'):
        item = release.get('packages', {}).get(name, {})
        if not item.get('url', '').startswith('https://github.com/qoopia/qoopia-downloads/releases/download/' + release['tag'] + '/') or version not in item.get('file', '') or not re.fullmatch('[0-9a-f]{64}', item.get('sha256', '')) or not isinstance(item.get('bytes'), int) or item.get('bytes', 0) <= 0:
            issues.append(name + ':invalid_package')
    if not appcast_build_is_newest(root, release['version']):
        issues.append('appcast:build_not_newer')
    if not re.fullmatch('[0-9a-f]{40}', release.get('source', '')):
        issues.append('release:invalid_source')
    if '## ' + package['version'] not in (root / 'CHANGELOG.md').read_text():
        issues.append('changelog:missing_version')
    if 'data-release-version="' + version + '"' not in (root / 'marketing-site/releases.html').read_text():
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public', action='store_true', help='Require published metadata; refuse an owner preview')
    args = parser.parse_args()
    issues = check(root, public=args.public)
    print(json.dumps({'status': 'FAIL' if issues else 'PASS', 'stage': 'owner_preview' if (root / 'LOCAL-RELEASE.json').exists() and not args.public else 'public', 'issues': issues}))
    raise SystemExit(bool(issues))
