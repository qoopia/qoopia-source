#!/usr/bin/env python3
"""Read-only launch checks; private status and transition log, no user content."""
import argparse
import concurrent.futures
import datetime
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET

UTC = datetime.timezone.utc
CORE = ('account_service', 'first_party_events', 'github_releases', 'operations', 'owner_memory_only', 'analytics_backup')


def analytics_issues(data, now):
    issues = []
    for source in CORE:
        row = next((r for r in data.get('source_runs', []) if r['source'] == source), None)
        if not row or row.get('status') != 'ok':
            issues.append('analytics:' + source)
        elif not row.get('finished_at') or (now - datetime.datetime.fromisoformat(row['finished_at'])).total_seconds() > 900:
            issues.append('analytics_stale:' + source)
    return issues


def expected_schema(value):
    """No built-in default: a number left behind by an older release reports a healthy server as broken."""
    text = str(value).strip() if value is not None else ''
    if not text.isdigit() or int(text) < 1:
        raise ValueError('Expected schema is not configured: pass --schema-version or set QOOPIA_SCHEMA_VERSION to a positive integer')
    return int(text)


def request(item):
    name, url = item
    started = time.monotonic()
    try:
        args = ['curl', '--fail', '--silent', '--show-error', '--max-time', '12', '--connect-timeout', '5']
        if name in ('downloads_tag', 'source_tag'):
            args += ['--head', '--location', '--output', '/dev/null', '--write-out', '%{url_effective}']
        r = subprocess.run(args + [url], capture_output=True, timeout=15)
        if r.returncode:
            return name, {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'}
        text_response = name in ('website', 'appcast', 'downloads_tag', 'source_tag')
        data = r.stdout.decode() if text_response else json.loads(r.stdout)
        if not text_response and not isinstance(data, dict):
            raise ValueError('Expected object')
        return name, {'ok': True, 'duration_ms': round((time.monotonic() - started) * 1000), 'data': data}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return name, {'ok': False, 'error': 'INVALID_OR_UNAVAILABLE_RESPONSE'}


def consistency_issues(data, version, schema, package_source, ios_version, ios_build):
    """Independent delivered surfaces must agree; separate source SHAs remain truthful."""
    issues = []
    for name in ('release', 'auth', 'memory', 'public_package', 'public_release'):
        if name in data and data[name].get('version') != version:
            issues.append(name + ':version_mismatch')
    release = data.get('release', {})
    if release and (release.get('tag') != 'v' + version or release.get('schema_version') != schema):
        issues.append('release:identity_mismatch')
    source = data.get('public_release', {})
    if source and (source.get('package_source') != package_source or source.get('schema_version') != schema):
        issues.append('public_release:provenance_mismatch')
    for name, repo in [('downloads_tag', 'qoopia-downloads'), ('source_tag', 'qoopia-source')]:
        if name in data and data[name].rstrip('/') != 'https://github.com/qoopia/' + repo + '/releases/tag/v' + version:
            issues.append(name + ':version_mismatch')
    if 'appcast' in data:
        try:
            item = ET.fromstring(data['appcast']).find('channel/item')
            if item is None:
                raise ValueError('Missing item')
            actual = item.findtext('{http://www.andymatuschak.org/xml-namespaces/sparkle}shortVersionString')
            enclosure = item.find('enclosure')
            mac = release.get('packages', {}).get('mac', {})
            if actual != version or enclosure is None or enclosure.get('url') != mac.get('url') or enclosure.get('length') != str(mac.get('bytes')):
                issues.append('appcast:package_mismatch')
        except (ET.ParseError, ValueError, TypeError, AttributeError):
            issues.append('appcast:invalid')
    if 'ios' in data:
        ios = data['ios']
        if ios.get('version') != ios_version or str(ios.get('build')) != ios_build or ios.get('status') not in ('preparing', 'review', 'available'):
            issues.append('ios:unexpected_channel_state')
        if ios.get('status') == 'available' and not str(ios.get('public_url', '')).startswith('https://testflight.apple.com/join/'):
            issues.append('ios:missing_public_invitation')
    return issues


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', required=True)
    p.add_argument('--source', required=True)
    p.add_argument('--package-source', default=os.environ.get('QOOPIA_PACKAGE_SOURCE'), help='Expected published installer source; defaults to runtime source')
    p.add_argument('--schema-version', default=os.environ.get('QOOPIA_SCHEMA_VERSION'), help='Expected deployed database schema; required, also read from QOOPIA_SCHEMA_VERSION')
    p.add_argument('--version', default=os.environ.get('QOOPIA_RELEASE_VERSION'), help='Expected stable product version; required')
    p.add_argument('--ios-version', default=os.environ.get('QOOPIA_IOS_VERSION'), help='Explicit separately reviewed iOS beta version; required')
    p.add_argument('--ios-build', default=os.environ.get('QOOPIA_IOS_BUILD'), help='Explicit separately reviewed iOS build; required')
    p.add_argument('--analytics', default='/srv/qoopia-analytics/latest.json')
    a = p.parse_args()
    try:
        a.schema_version = expected_schema(a.schema_version)
    except ValueError as error:
        p.error(str(error))
    if not re.fullmatch(r'\d+\.\d+\.\d+', a.version or ''):
        p.error('Expected stable version is not configured')
    if not re.fullmatch(r'\d+\.\d+\.\d+', a.ios_version or '') or not re.fullmatch(r'[1-9]\d*', a.ios_build or ''):
        p.error('Expected iOS beta version/build is not configured')
    os.umask(0o077)
    root = Path(a.root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    now = datetime.datetime.now(UTC)
    endpoints = [('website', 'https://qoopia.ai/'), ('release', 'https://qoopia.ai/release.json'), ('auth', 'https://auth.qoopia.ai/health'), ('memory', 'https://mcp.qoopia.ai/ready'),
                 ('appcast', 'https://qoopia.ai/updates/macos/appcast.xml'), ('ios', 'https://qoopia.ai/ios-release.json'),
                 ('public_package', 'https://raw.githubusercontent.com/qoopia/qoopia-source/v' + a.version + '/package.json'),
                 ('public_release', 'https://raw.githubusercontent.com/qoopia/qoopia-source/v' + a.version + '/RELEASE.json'),
                 ('downloads_tag', 'https://github.com/qoopia/qoopia-downloads/releases/latest'),
                 ('source_tag', 'https://github.com/qoopia/qoopia-source/releases/latest')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(endpoints)) as pool:
        results = dict(pool.map(request, endpoints))
    issues = [name for name, r in results.items() if not r['ok']]
    for name, validate in [('release', lambda d: d.get('source') == (a.package_source or a.source)), ('auth', lambda d: d.get('ready') is True), ('memory', lambda d: d.get('release_sha') == a.source and d.get('schema_version') == a.schema_version and d.get('status') == 'ready' and bool(d.get('checks')) and all(v == 'ok' for v in d['checks'].values()))]:
        r = results[name]
        if r['ok'] and not validate(r['data']):
            issues.append(name + ':unexpected_state')
    issues.extend(consistency_issues({name: r['data'] for name, r in results.items() if r['ok']}, a.version, a.schema_version, a.package_source or a.source, a.ios_version, a.ios_build))
    for r in results.values():
        r.pop('data', None)
    try:
        analytics = json.loads(Path(a.analytics).read_text())
        issues.extend(analytics_issues(analytics, now))
        optional = [{'source': r['source'], 'status': r['status']} for r in analytics.get('source_runs', []) if r['source'] in ('cloudflare', 'resend', 'github_traffic')]
    except (OSError, ValueError, KeyError, TypeError):
        issues.append('analytics:unreadable')
        optional = []
    disk = shutil.disk_usage(root)
    if disk.free < max(10 * 1024**3, disk.total * 0.05):
        issues.append('disk:low_space')
    status = {'at': now.isoformat(), 'status': 'ALERT' if issues else 'OK', 'issues': sorted(issues), 'version': a.version, 'ios': {'version': a.ios_version, 'build': a.ios_build, 'channel': 'separate_beta'}, 'source': a.source, 'package_source': a.package_source or a.source, 'http': results, 'disk_free_bytes': disk.free, 'optional_sources': optional}
    current = root / 'status.json'
    try:
        previous = json.loads(current.read_text())
    except (OSError, ValueError):
        previous = {}
    if previous.get('issues') != status['issues']:
        with (root / 'transitions.jsonl').open('a') as f:
            f.write(json.dumps({'at': status['at'], 'status': status['status'], 'issues': status['issues']}) + '\n')
    temp = root / 'status.tmp'
    temp.write_text(json.dumps(status, indent=2) + '\n')
    temp.replace(current)
    print(json.dumps(status))
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
