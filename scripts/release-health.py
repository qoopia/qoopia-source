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
# Only the owner's memory server runs an owner preview; every other surface stays on the public stable release.
PREVIEW_SURFACES = ('memory',)
PREVIEW_CONFIG = (('version', 'QOOPIA_PREVIEW_VERSION', r'\d+\.\d+\.\d+'), ('source', 'QOOPIA_PREVIEW_RELEASE_SHA', r'[0-9a-f]{40}'),
                  ('schema_version', 'QOOPIA_PREVIEW_SCHEMA_VERSION', r'[1-9]\d*'))


def preview_order_issues(public_version, public_schema, version, schema):
    """Shared with check-release-metadata.py: an owner preview is strictly newer than the public release
    and its schema never behind it. A preview equal to public is stale configuration, not a second stage."""
    key = lambda v: tuple(map(int, v.split('.')))
    return (['not_newer_than_public'] if key(version) <= key(public_version) else []) + (['schema_behind_public'] if schema < public_schema else [])


def preview_stage(version, source, schema, public_version, public_schema):
    """(expectation, issues). No value set: no preview, the single public stage. Any value set: an owner preview
    is intended, so a missing, malformed or not-newer value is an issue instead of a silent fall back to public."""
    given = {key: (str(value).strip() if value is not None else '', env, pattern) for (key, env, pattern), value in zip(PREVIEW_CONFIG, (version, source, schema))}
    if not any(value for value, _, _ in given.values()):
        return None, []
    issues = [('config_missing:' if not value else 'config_invalid:') + env for value, env, pattern in given.values() if not re.fullmatch(pattern, value)]
    if issues:
        return None, issues
    expect = {key: value for key, (value, _, _) in given.items()}
    expect['schema_version'] = int(expect['schema_version'])
    return expect, preview_order_issues(public_version, public_schema, expect['version'], expect['schema_version'])


def runtime_issues(data, expect):
    """The memory server's /ready against the stage it belongs to. Without a usable expectation
    (incomplete preview configuration) only readiness is judged; the configuration issue is reported separately."""
    checks = data.get('checks')
    ready = data.get('status') == 'ready' and isinstance(checks, dict) and bool(checks) and all(v == 'ok' for v in checks.values())
    issues = [] if not expect or data.get('version') == expect['version'] else ['memory:version_mismatch']
    if not ready or (expect and (data.get('release_sha') != expect['source'] or data.get('schema_version') != expect['schema_version'])):
        issues.append('memory:unexpected_state')
    return issues


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
            # scripts/update-feed.ts writes exactly one item; Sparkle offers the highest build of all
            # items, so an extra item would be what installed apps get while only the first was checked.
            items = ET.fromstring(data['appcast']).findall('channel/item')
            if len(items) != 1:
                raise ValueError('Expected one item')
            item = items[0]
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


LOOPBACK = ('127.0.0.1', '::1', 'localhost')


def loopback_http(url):
    """A receiver on this host (scripts/ops-alert-relay.py) needs no TLS; anything else must be HTTPS."""
    parts = urllib.parse.urlsplit(url)
    return parts.scheme == 'http' and parts.hostname in LOOPBACK


def alert_channels(path):
    """The owner's qoopia-alert-channels/1 policy, the same file server ops alerts use (QOOPIA_OPS_CHANNELS_FILE).
    The monitor also accepts a loopback http receiver; the server's outbox keeps refusing it."""
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
        if not re.fullmatch(r'[A-Za-z0-9_-]{43,86}', encoded) or not (channel['url'].startswith('https://') or loopback_http(channel['url'])) or urllib.parse.urlsplit(channel['url']).hostname not in channel['allowed_hosts']:
            raise ValueError('ALERT_POLICY_INVALID')
        channels.append((channel['url'], base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))))
    return channels


def deliver_alert(channels, alert):
    """Signed envelope and receiver receipt as for server operational alerts (src/services/event-outbox.ts)."""
    body = json.dumps({'id': alert['id'], 'event_type': 'operational_alert', 'payload': alert['payload']}, separators=(',', ':')).encode()
    for url, key in channels:
        signature = base64.urlsafe_b64encode(hmac.new(key, body, hashlib.sha256).digest()).rstrip(b'=').decode()
        try:
            r = subprocess.run(['curl', '--fail', '--silent', '--max-time', '12', '--connect-timeout', '5', '--proto', '=http' if loopback_http(url) else '=https',
                                '-H', 'content-type: application/json', '-H', 'x-qoopia-event-id: ' + alert['id'], '-H', 'x-qoopia-signature: sha256=' + signature,
                                '--data-binary', '@-', url], input=body, capture_output=True, timeout=15)
            receipt = json.loads(r.stdout) if r.returncode == 0 and len(r.stdout) <= 4096 else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
        if isinstance(receipt, dict) and receipt.get('accepted') is True and receipt.get('event_id') == alert['id'] and receipt.get('payload_sha256') == hashlib.sha256(body).hexdigest():
            return True
    return False


def invariant_issues(path):
    """Critical alerts of the host invariant monitor (invariant_check.py) that fired and have not resolved.
    Its JSONL stream is append-only and small; warnings stay in that stream only."""
    if not path:
        return []
    try:
        lines = Path(path).read_text().splitlines()
    except FileNotFoundError:
        return []
    except OSError:
        return ['invariant:unreadable']
    active = {}
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get('severity') != 'critical':
            continue
        if record.get('event') == 'resolved':
            active.pop(record.get('fingerprint'), None)
        else:
            active[record.get('fingerprint')] = record.get('check')
    # Only short plain check names reach status.json and the alert text.
    return sorted({'invariant:' + (check if isinstance(check, str) and re.fullmatch(r'[a-z0-9_]{1,40}', check) else 'unknown') for check in active.values()})


def unit_issues(units):
    """Failed timer jobs (release source check, system backup, ...) become monitor issues instead of journal-only failures."""
    issues = []
    for unit in units:
        try:
            failed = subprocess.run(['systemctl', 'is-failed', '--quiet', unit], capture_output=True, timeout=10).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return ['units:unavailable']
        if failed:
            issues.append('unit_failed:' + unit.removesuffix('.service'))
    return issues


def offsite_issues(path, now, max_age_hours=26):
    """The daily off-host copy (deploy/qoopia-offsite-backup.sh) records each run; the newest ok record must be fresh
    and must include the sign-in database. A silent cron failure otherwise looks exactly like a working backup."""
    if not path:
        return []
    def parsed(line):
        # A record an older script broke over several lines must not hide every later one.
        try:
            return json.loads(line)
        except ValueError:
            return None
    try:
        records = [parsed(line) for line in Path(path).read_text().splitlines() if line.strip()]
        ok = [r for r in records if isinstance(r, dict) and r.get('status') == 'ok']
        last = max(ok, key=lambda r: datetime.datetime.fromisoformat(r['at'].replace('Z', '+00:00')), default=None)
        age = (now - datetime.datetime.fromisoformat(last['at'].replace('Z', '+00:00'))).total_seconds() if last else None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return ['backup:offsite_unreadable']
    if age is None or not 0 <= age <= max_age_hours * 3600:
        return ['backup:offsite_stale']
    return [] if last.get('auth') == 'ok' else ['backup:auth_offsite_missing']


MAINTENANCE_CAP = datetime.timedelta(hours=2)


def maintenance_until(root, now):
    """Deploy window: `maintenance-until` in the monitor root holds an ISO UTC end time, honoured for at most
    two hours after the file was written so a forgotten file cannot silence the monitor."""
    file = Path(root) / 'maintenance-until'
    try:
        until = datetime.datetime.fromisoformat(file.read_text().strip().replace('Z', '+00:00'))
        written = datetime.datetime.fromtimestamp(file.stat().st_mtime, UTC)
    except (OSError, ValueError):
        return None
    if until.tzinfo is None:
        return None
    until = min(until, written + MAINTENANCE_CAP)
    return until if until > now else None


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
    p.add_argument('--preview-version', default=os.environ.get('QOOPIA_PREVIEW_VERSION'), help='Owner preview version on the memory server; unset when memory runs the public release')
    p.add_argument('--preview-source', default=os.environ.get('QOOPIA_PREVIEW_RELEASE_SHA'), help='Owner preview runtime release SHA on the memory server')
    p.add_argument('--preview-schema-version', default=os.environ.get('QOOPIA_PREVIEW_SCHEMA_VERSION'), help='Owner preview database schema on the memory server')
    p.add_argument('--analytics', default='/srv/qoopia-analytics/latest.json')
    p.add_argument('--git-mirror', default='/srv/qoopia/git-mirror')
    p.add_argument('--alert-channels', default=os.environ.get('QOOPIA_OPS_CHANNELS_FILE'), help='Owner qoopia-alert-channels/1 policy that receives OK/ALERT transitions; nothing is sent when unset')
    p.add_argument('--invariant-alerts', default=os.environ.get('QOOPIA_INVARIANT_ALERTS'), help='invariant_check.py JSONL stream; active critical alerts become issues')
    p.add_argument('--offsite-log', default=os.environ.get('QOOPIA_OFFSITE_LOG'), help='offsite-backup.jsonl; a stale or incomplete last copy is an issue')
    p.add_argument('--units', default=os.environ.get('QOOPIA_MONITOR_UNITS', ''), help='Comma-separated systemd units whose failed state is an issue')
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
    preview, preview_problems = preview_stage(a.preview_version, a.preview_source, a.preview_schema_version, a.version, a.schema_version)
    staged = preview is not None or bool(preview_problems)
    stage_of = {name: 'owner_preview' if staged and name in PREVIEW_SURFACES else 'public' for name, _ in endpoints}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(endpoints)) as pool:
        results = dict(pool.map(request, endpoints))
    # Each surface is judged only against the expectation of its own stage; issues keep the stage in their name.
    found = {'public': [], 'owner_preview': list(preview_problems)}
    for issue in request_issues(results):
        found[stage_of[issue.split(':', 1)[0]]].append(issue)
    data = {name: r['data'] for name, r in results.items() if r['ok']}
    for name, validate in [('release', lambda d: d.get('source') == (a.package_source or a.source)), ('auth', lambda d: d.get('ready') is True and d.get('release_sha') == (a.auth_source or a.source))]:
        if name in data and not validate(data[name]):
            found['public'].append(name + ':unexpected_state')
    found['public'] += consistency_issues({k: v for k, v in data.items() if stage_of[k] == 'public' and k != 'memory'}, a.version, a.schema_version, a.package_source or a.source, a.ios_version, a.ios_build)
    if 'memory' in data:
        found[stage_of['memory']] += runtime_issues(data['memory'], preview if staged else {'version': a.version, 'source': a.source, 'schema_version': a.schema_version})
    if 'review' in data and data['review'].get('release_sha') != a.source:
        found['public'].append('review:source_mismatch')
    found['public'] += mirror_issues(a.git_mirror, a.version)
    issues = found['public'] + ['owner_preview:' + issue for issue in found['owner_preview']]
    stages = {'public': {'version': a.version, 'schema_version': a.schema_version, 'source': a.source, 'package_source': a.package_source or a.source,
                         'auth_source': a.auth_source or a.source, 'issues': sorted(found['public'])}}
    if staged:
        stages['owner_preview'] = {**(preview or {'version': None, 'source': None, 'schema_version': None}), 'surfaces': list(PREVIEW_SURFACES), 'issues': sorted(found['owner_preview'])}
    for name, r in results.items():
        r.pop('data', None)
        r['stage'] = stage_of[name]
    try:
        analytics = json.loads(Path(a.analytics).read_text())
        issues.extend(analytics_issues(analytics, now))
        optional = [{'source': r['source'], 'status': r['status']} for r in analytics.get('source_runs', []) if r['source'] in ('cloudflare', 'resend', 'github_traffic')]
    except (OSError, ValueError, KeyError, TypeError):
        issues.append('analytics:unreadable')
        optional = []
    issues += invariant_issues(a.invariant_alerts) + offsite_issues(a.offsite_log, now) + unit_issues([u.strip() for u in a.units.split(',') if u.strip()])
    disk = shutil.disk_usage(root)
    if disk.free < max(10 * 1024**3, disk.total * 0.05):
        issues.append('disk:low_space')
    summary = ('ALERT' if issues else 'OK') + ' — public ' + a.version + (', owner preview ' + (preview['version'] if preview else 'misconfigured') + ' on ' + '/'.join(PREVIEW_SURFACES) if staged else '')
    status = {'at': now.isoformat(), 'status': 'ALERT' if issues else 'OK', 'summary': summary, 'issues': sorted(issues), 'stages': stages, 'version': a.version, 'ios': {'version': a.ios_version, 'build': a.ios_build, 'channel': 'separate_beta'}, 'source': a.source, 'package_source': a.package_source or a.source, 'http': results, 'disk_free_bytes': disk.free, 'optional_sources': optional}
    current = root / 'status.json'
    try:
        previous = json.loads(current.read_text())
    except (OSError, ValueError):
        previous = {}
    pending = previous.get('alert_pending')
    window = maintenance_until(root, now)
    if window:
        # The deploy window keeps the pre-deploy baseline: a problem that outlives the window still
        # differs from it and alerts then; one the deploy fixed never pages anyone.
        status.update(status='MAINTENANCE', summary='MAINTENANCE until ' + window.isoformat() + ' — ' + summary,
                      maintenance_until=window.isoformat(), maintenance_issues=status['issues'], issues=previous.get('issues', []))
    elif previous.get('issues') != status['issues']:
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
    return 1 if (issues and not window) or state in ('failed', 'policy_invalid') else 0


if __name__ == '__main__':
    raise SystemExit(main())
