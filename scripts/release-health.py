#!/usr/bin/env python3
"""Read-only launch checks; private status and transition log, no user content."""
import argparse
import base64
import concurrent.futures
import datetime
import hashlib
import hmac
import json
import os
import re
from pathlib import Path
import shutil
import stat
import subprocess
import time
import urllib.parse
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


READINESS = ('memory', 'review')


def not_ready(body):
    """A structured /ready 503 names its failed checks; anything else stays a generic failure."""
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if not (isinstance(data, dict) and data.get('status') == 'not_ready' and isinstance(data.get('checks'), dict)):
        return {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'}
    # Only short plain check names reach status.json; the monitor never echoes a response body.
    failed = sorted(k for k, v in data['checks'].items() if v != 'ok' and isinstance(k, str) and re.fullmatch(r'[a-z_]{1,40}', k))
    return {'ok': False, 'error': 'NOT_READY', 'failed_checks': failed}


def request_issues(results):
    issues = []
    for name, r in results.items():
        if r['ok']:
            continue
        failed = (r.get('failed_checks') or ['unknown']) if r.get('error') == 'NOT_READY' else None
        issues += [name + ':not_ready:' + check for check in failed] if failed else [name]
    return issues


def request(item):
    name, url = item
    started = time.monotonic()
    try:
        args = ['curl', '--silent', '--show-error', '--max-time', '12', '--connect-timeout', '5']
        # Readiness keeps its 503 body (which check failed) instead of letting --fail discard it.
        args += ['--write-out', '\n%{http_code}'] if name in READINESS else ['--fail']
        if name in ('downloads_tag', 'source_tag'):
            args += ['--head', '--location', '--output', '/dev/null', '--write-out', '%{url_effective}']
        r = subprocess.run(args + [url], capture_output=True, timeout=15)
        if r.returncode:
            return name, {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'}
        body = r.stdout
        if name in READINESS:
            body, _, status = body.rpartition(b'\n')
            if status != b'200':
                return name, not_ready(body) if status == b'503' else {'ok': False, 'error': 'HTTP_OR_NETWORK_FAILURE'}
        text_response = name in ('website', 'appcast', 'downloads_tag', 'source_tag', 'downloads_readme')
        data = body.decode() if text_response else json.loads(body)
        if not text_response and not isinstance(data, dict):
            raise ValueError('Expected object')
        return name, {'ok': True, 'duration_ms': round((time.monotonic() - started) * 1000), 'data': data}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return name, {'ok': False, 'error': 'INVALID_OR_UNAVAILABLE_RESPONSE'}


def consistency_issues(data, version, schema, package_source, ios_version, ios_build):
    """Independent delivered surfaces must agree; separate source SHAs remain truthful."""
    issues = []
    for name in ('release', 'auth', 'memory', 'public_package', 'public_release', 'public_main', 'downloads_release', 'pages_release', 'review'):
        if name in data and data[name].get('version') != version:
            issues.append(name + ':version_mismatch')
    release = data.get('release', {})
    if release and (release.get('tag') != 'v' + version or release.get('schema_version') != schema):
        issues.append('release:identity_mismatch')
    source = data.get('public_release', {})
    if source and (source.get('package_source') != package_source or source.get('schema_version') != schema):
        issues.append('public_release:provenance_mismatch')
    for name in ('downloads_release', 'pages_release'):
        row = data.get(name)
        source_key = 'source' if name == 'pages_release' else 'package_source'
        if row and (row.get(source_key) != package_source or row.get('schema_version') != schema):
            issues.append(name + ':provenance_mismatch')
    if 'review' in data and (data['review'].get('status') != 'ready' or data['review'].get('schema_version') != schema):
        issues.append('review:unexpected_state')
    if 'downloads_readme' in data:
        # Check current headline/CTA only; older upgrade requirements remain valid history.
        claims = re.findall(r'(?:^# Qoopia |Download Qoopia )(\d+\.\d+\.\d+)', data['downloads_readme'], re.M)
        if any(claim != version for claim in claims):
            issues.append('downloads_readme:stale_version')
    for name, repo in [('downloads_tag', 'qoopia-downloads'), ('source_tag', 'qoopia-source')]:
        if name in data and data[name].rstrip('/') != 'https://github.com/qoopia/' + repo + '/releases/tag/v' + version:
            issues.append(name + ':version_mismatch')
    if 'appcast' in data:
        try:
            item = ET.fromstring(data['appcast']).find('channel/item')
            if item is None:
                raise ValueError('Missing item')
            sparkle = '{http://www.andymatuschak.org/xml-namespaces/sparkle}'
            actual = item.findtext(sparkle + 'shortVersionString')
            enclosure = item.find('enclosure')
            mac = release.get('packages', {}).get('mac', {})
            if actual != version or enclosure is None or enclosure.get('url') != mac.get('url') or enclosure.get('length') != str(mac.get('bytes')):
                issues.append('appcast:package_mismatch')
            # Installed apps skip an item silently: no build number, no Ed25519 signature, or a newer
            # minimum macOS than the download page promises strands them on the old release.
            minimum = re.search(r'macOS (\d+\.\d+)', mac.get('requirements', ''))
            if not (item.findtext(sparkle + 'version') or '').isdigit() or enclosure is None or not re.fullmatch(r'[A-Za-z0-9+/]{86}==', enclosure.get(sparkle + 'edSignature', '')) or not minimum or item.findtext(sparkle + 'minimumSystemVersion') != minimum.group(1):
                issues.append('appcast:not_installable')
        except (ET.ParseError, ValueError, TypeError, AttributeError):
            issues.append('appcast:invalid')
    if 'ios' in data:
        ios = data['ios']
        if ios.get('version') != ios_version or str(ios.get('build')) != ios_build or ios.get('status') not in ('preparing', 'review', 'available'):
            issues.append('ios:unexpected_channel_state')
        if ios.get('status') == 'available' and not str(ios.get('public_url', '')).startswith('https://testflight.apple.com/join/'):
            issues.append('ios:missing_public_invitation')
    return issues


def mirror_issues(path, version):
    """Read the sync receipt; the public health service does not get GitHub credentials."""
    try:
        def git(*args):
            return subprocess.check_output(['git', '-C', path, *args], stderr=subprocess.DEVNULL, timeout=15, text=True).strip()
        local = git('rev-parse', 'refs/heads/main')
        receipt = json.loads((Path(path) / 'sync-status.json').read_text())
        age = time.time() - receipt['checked_at']
        if receipt.get('status') != 'OK' or not 0 <= age <= 600:
            return ['git_mirror:sync_stale_or_failed']
        package = json.loads(git('show', 'refs/heads/main:package.json'))
        return (['git_mirror:stale_main'] if local != receipt.get('remote_main') else []) + (['git_mirror:version_mismatch'] if package.get('version') != version else [])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return ['git_mirror:unavailable']


def alert_channels(path):
    """The owner's qoopia-alert-channels/1 policy, the same file server ops alerts use (QOOPIA_OPS_CHANNELS_FILE)."""
    if not path or not os.path.exists(path):
        return []
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 16384:
        raise ValueError('ALERT_POLICY_UNSAFE')
    policy = json.loads(Path(path).read_text())
    if policy.get('format') != 'qoopia-alert-channels/1' or not isinstance(policy.get('channels'), list) or len(policy['channels']) > 2:
        raise ValueError('ALERT_POLICY_INVALID')
    channels = []
    for channel in policy['channels']:
        encoded = channel['signing_key_base64url']
        if not re.fullmatch(r'[A-Za-z0-9_-]{43,86}', encoded) or not channel['url'].startswith('https://') or urllib.parse.urlsplit(channel['url']).hostname not in channel['allowed_hosts']:
            raise ValueError('ALERT_POLICY_INVALID')
        channels.append((channel['url'], base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))))
    return channels


def deliver_alert(channels, alert):
    """Signed envelope and receiver receipt as for server operational alerts (src/services/event-outbox.ts)."""
    body = json.dumps({'id': alert['id'], 'event_type': 'operational_alert', 'payload': alert['payload']}, separators=(',', ':')).encode()
    for url, key in channels:
        signature = base64.urlsafe_b64encode(hmac.new(key, body, hashlib.sha256).digest()).rstrip(b'=').decode()
        try:
            r = subprocess.run(['curl', '--fail', '--silent', '--max-time', '12', '--connect-timeout', '5', '--proto', '=https',
                                '-H', 'content-type: application/json', '-H', 'x-qoopia-event-id: ' + alert['id'], '-H', 'x-qoopia-signature: sha256=' + signature,
                                '--data-binary', '@-', url], input=body, capture_output=True, timeout=15)
            receipt = json.loads(r.stdout) if r.returncode == 0 and len(r.stdout) <= 4096 else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
        if isinstance(receipt, dict) and receipt.get('accepted') is True and receipt.get('event_id') == alert['id'] and receipt.get('payload_sha256') == hashlib.sha256(body).hexdigest():
            return True
    return False


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', required=True)
    p.add_argument('--source', required=True)
    p.add_argument('--package-source', default=os.environ.get('QOOPIA_PACKAGE_SOURCE'), help='Expected published installer source; defaults to runtime source')
    p.add_argument('--auth-source', default=os.environ.get('QOOPIA_AUTH_RELEASE_SHA'), help='Expected sign-in service release SHA; defaults to runtime source')
    p.add_argument('--schema-version', default=os.environ.get('QOOPIA_SCHEMA_VERSION'), help='Expected deployed database schema; required, also read from QOOPIA_SCHEMA_VERSION')
    p.add_argument('--version', default=os.environ.get('QOOPIA_RELEASE_VERSION'), help='Expected stable product version; required')
    p.add_argument('--ios-version', default=os.environ.get('QOOPIA_IOS_VERSION'), help='Explicit separately reviewed iOS beta version; required')
    p.add_argument('--ios-build', default=os.environ.get('QOOPIA_IOS_BUILD'), help='Explicit separately reviewed iOS build; required')
    p.add_argument('--analytics', default='/srv/qoopia-analytics/latest.json')
    p.add_argument('--git-mirror', default='/srv/qoopia/git-mirror')
    p.add_argument('--alert-channels', default=os.environ.get('QOOPIA_OPS_CHANNELS_FILE'), help='Owner qoopia-alert-channels/1 policy that receives OK/ALERT transitions; nothing is sent when unset')
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
                 ('public_main', 'https://raw.githubusercontent.com/qoopia/qoopia-source/main/package.json'),
                 ('downloads_release', 'https://raw.githubusercontent.com/qoopia/qoopia-downloads/main/RELEASE.json'),
                 ('downloads_readme', 'https://raw.githubusercontent.com/qoopia/qoopia-downloads/main/README.md'),
                 ('pages_release', 'https://qoopia-site.pages.dev/release.json'),
                 ('review', 'https://review.qoopia.ai/ready'),
                 ('downloads_tag', 'https://github.com/qoopia/qoopia-downloads/releases/latest'),
                 ('source_tag', 'https://github.com/qoopia/qoopia-source/releases/latest')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(endpoints)) as pool:
        results = dict(pool.map(request, endpoints))
    issues = request_issues(results)
    for name, validate in [('release', lambda d: d.get('source') == (a.package_source or a.source)), ('auth', lambda d: d.get('ready') is True and d.get('release_sha') == (a.auth_source or a.source)), ('memory', lambda d: d.get('release_sha') == a.source and d.get('schema_version') == a.schema_version and d.get('status') == 'ready' and bool(d.get('checks')) and all(v == 'ok' for v in d['checks'].values()))]:
        r = results[name]
        if r['ok'] and not validate(r['data']):
            issues.append(name + ':unexpected_state')
    issues.extend(consistency_issues({name: r['data'] for name, r in results.items() if r['ok']}, a.version, a.schema_version, a.package_source or a.source, a.ios_version, a.ios_build))
    if results['review']['ok'] and results['review']['data'].get('release_sha') != a.source:
        issues.append('review:source_mismatch')
    issues.extend(mirror_issues(a.git_mirror, a.version))
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
    pending = previous.get('alert_pending')
    if previous.get('issues') != status['issues']:
        transition = {'at': status['at'], 'status': status['status'], 'issues': status['issues']}
        with (root / 'transitions.jsonl').open('a') as f:
            f.write(json.dumps(transition) + '\n')
        if previous or issues:
            # Only the latest transition is owed; an undelivered one is retried every run.
            pending = {'id': 'release-health-' + hashlib.sha256(json.dumps(transition).encode()).hexdigest()[:32],
                       'payload': {'installation': 'release-health', 'component': 'public-release', 'subject': status['status'], 'cause': ','.join(status['issues'])[:2048] or None, 'at': status['at']}}
    try:
        channels = alert_channels(a.alert_channels)
        state = 'not_configured' if not channels else 'idle' if not pending else 'delivered' if deliver_alert(channels, pending) else 'failed'
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        state = 'policy_invalid'
    status['alert'] = {'state': state, 'event_id': pending and pending['id']}
    status['alert_pending'] = None if state == 'delivered' else pending
    temp = root / 'status.tmp'
    temp.write_text(json.dumps(status, indent=2) + '\n')
    temp.replace(current)
    print(json.dumps(status))
    return 1 if issues or state in ('failed', 'policy_invalid') else 0


if __name__ == '__main__':
    raise SystemExit(main())
