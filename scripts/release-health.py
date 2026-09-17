#!/usr/bin/env python3
"""Read-only launch checks; private status and transition log, no user content."""
import argparse
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

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


def request(item):
    name, url = item
    started = time.monotonic()
    try:
        r = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '12', '--connect-timeout', '5', url], capture_output=True, timeout=15)
        if r.returncode:
            return name, {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'}
        data = json.loads(r.stdout) if name != 'website' else None
        if name != 'website' and not isinstance(data, dict):
            raise ValueError('Expected object')
        return name, {'ok': True, 'duration_ms': round((time.monotonic() - started) * 1000), 'data': data}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return name, {'ok': False, 'error': 'INVALID_OR_UNAVAILABLE_RESPONSE'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', required=True)
    p.add_argument('--source', required=True)
    p.add_argument('--package-source', default=os.environ.get('QOOPIA_PACKAGE_SOURCE'), help='Expected published installer source; defaults to runtime source')
    p.add_argument('--schema-version', type=int, default=int(os.environ.get('QOOPIA_SCHEMA_VERSION', '43')), help='Expected deployed database schema')
    p.add_argument('--analytics', default='/srv/qoopia-analytics/latest.json')
    a = p.parse_args()
    os.umask(0o077)
    root = Path(a.root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    now = datetime.datetime.now(UTC)
    endpoints = [('website', 'https://qoopia.ai/'), ('release', 'https://qoopia.ai/release.json'), ('auth', 'https://auth.qoopia.ai/health'), ('memory', 'https://mcp.qoopia.ai/ready')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = dict(pool.map(request, endpoints))
    issues = [name for name, r in results.items() if not r['ok']]
    for name, validate in [('release', lambda d: d.get('source') == (a.package_source or a.source)), ('auth', lambda d: d.get('ready') is True), ('memory', lambda d: d.get('release_sha') == a.source and d.get('schema_version') == a.schema_version and d.get('status') == 'ready' and bool(d.get('checks')) and all(v == 'ok' for v in d['checks'].values()))]:
        r = results[name]
        if r['ok'] and not validate(r['data']):
            issues.append(name + ':unexpected_state')
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
    status = {'at': now.isoformat(), 'status': 'ALERT' if issues else 'OK', 'issues': sorted(issues), 'source': a.source, 'package_source': a.package_source or a.source, 'http': results, 'disk_free_bytes': disk.free, 'optional_sources': optional}
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
