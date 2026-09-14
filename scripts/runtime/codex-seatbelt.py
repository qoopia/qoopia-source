"""Explicit Leo opt-in. Native children get exactly one verified outer Seatbelt.
The controller is not a model process. No real-store write probes or auth reads.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import uuid

MODE = 'macos-seatbelt-only-bookkeeping/1'


def directory(path):
    path = Path(path)
    try:
        s = path.lstat()
    except FileNotFoundError:
        raise ValueError('Required existing parent/target directory absent: ' + str(path))
    if (not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode) or path.resolve() != path
            or s.st_uid != os.getuid() or s.st_mode & 0o022):
        raise ValueError('Not an owned canonical private directory: ' + str(path))
    return s.st_dev, s.st_ino


def validate_store(store):
    """Metadata only; never read auth/config/skills or installation_id contents."""
    store = Path(store)
    pins = {str(p): directory(p) for p in [store, store / 'tmp', store / 'tmp/arg0']}
    installation = store / 'installation_id'
    try:
        s = installation.lstat()
    except FileNotFoundError:
        s = None  # Only this literal may be created; its parent must already exist.
    if s and (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid()
              or s.st_mode & 0o022 or installation.resolve() != installation):
        raise ValueError('Unsafe installation_id target (link/type/owner/mode)')
    # Existing hardlinks could turn an allowed arg0 write into an auth/config write.
    # Official arg0 symlinks are not followed; Seatbelt resolves writes to their targets.
    pending = [(store / 'tmp/arg0', 0)]
    count = 0
    while pending:
        parent, depth = pending.pop()
        if depth > 20:
            raise ValueError('arg0 metadata depth exceeded')
        for p in parent.iterdir():
            count += 1
            if count > 4096:
                raise ValueError('arg0 metadata entry limit exceeded')
            s = p.lstat()
            if s.st_uid != os.getuid():
                raise ValueError('Foreign owner in arg0 bookkeeping')
            if stat.S_ISDIR(s.st_mode):
                directory(p)
                pending.append((p, depth + 1))
            elif stat.S_ISREG(s.st_mode):
                if s.st_nlink != 1 or s.st_mode & 0o022:
                    raise ValueError('Hardlink or unsafe mode in arg0 bookkeeping')
            elif not stat.S_ISLNK(s.st_mode):
                raise ValueError('Special file in arg0 bookkeeping')
    return pins


def profile(outer, store):
    quote = lambda p: json.dumps(str(p))
    return ('(version 1)\n(allow default)\n(deny file-write*)\n(deny file-link)\n'
            '(allow file-write* (subpath ' + quote(outer) + '))\n'
            '(allow file-write-data (literal "/dev/null"))\n'
            '(allow file-write* (literal ' + quote(store / 'installation_id') + '))\n'
            '(allow file-write* (subpath ' + quote(store / 'tmp/arg0') + '))\n'
            '(deny file-write* (literal ' + quote(store / 'auth.json') + ') (literal ' + quote(store / 'config.toml') + ') (subpath ' + quote(store / 'skills') + '))\n'
            '(deny file-read-data (literal ' + quote(store / '.env') + '))\n')


def binding(outer, store):
    return {'mode': MODE, 'outer_root': str(outer),
            'profile_digest': hashlib.sha256(profile(outer, store).encode()).hexdigest(),
            'installation_id': str(store / 'installation_id'), 'arg0': str(store / 'tmp/arg0')}


def validate_binding(value):
    if set(value) != {'mode', 'outer_root', 'profile_digest', 'installation_id', 'arg0'} or value['mode'] != MODE:
        raise ValueError('Explicit exact outer Seatbelt binding required')
    outer, installation = Path(value['outer_root']), Path(value['installation_id'])
    store = installation.parent
    if not outer.is_absolute() or not outer.name.startswith('leo-p2-codex-seatbelt-'):
        raise ValueError('Generated disposable outer root required')
    directory(outer)
    if store == outer or store in outer.parents or outer in store.parents:
        raise ValueError('Selected store and disposable outer root must be disjoint')
    if value != binding(outer, store):
        raise ValueError('Outer profile digest or exact two path exceptions mismatch')
    pins = validate_store(store)
    return outer, store, pins


PROBE = '''import os,pathlib,sys
operation,target,source=sys.argv[1:]
try:
 if operation=='link': os.link(source,target)
 elif operation=='symlink': os.symlink(source,target)
 elif operation=='mkdir': os.mkdir(target,0o700)
 elif operation=='chmod': os.chmod(target,0o700)
 else:
  fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
  os.write(fd,b'synthetic-probe\\n');os.close(fd)
except PermissionError: sys.exit(13)
'''


def probe(policy, target, operation='write', source=''):
    p = subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, '/usr/bin/python3', '-c', PROBE,
                        operation, str(target), str(source)], capture_output=True, text=True, timeout=10,
                       env={'PATH': '/usr/bin:/bin', 'HOME': str(target.parent), 'TMPDIR': str(target.parent)})
    return {'path': str(target), 'operation': operation, 'exit_code': p.returncode, 'stderr': p.stderr}


def synthetic_controls(outer):
    """Actual Seatbelt matrix, ONLY on generated synthetic data outside outer root."""
    fixture = Path(tempfile.mkdtemp(prefix='leo-p2-seatbelt-negative-', dir='/private/tmp')).resolve()
    store = fixture / 'store'
    (store / 'tmp/arg0').mkdir(parents=True, mode=0o700)
    (store / 'skills').mkdir(mode=0o700)
    for p in [store / 'installation_id', store / 'auth.json', store / 'config.toml', store / 'skills/SKILL.md', store / 'sibling']:
        p.write_text('synthetic fixture only\n')
    (store / 'tmp/arg0/redirect').symlink_to(store / 'auth.json')
    policy = profile(outer, store)
    cases = [(outer / 'allowed-probe', True), (store / 'installation_id', True), (store / 'tmp/arg0/allowed', True),
             (store / 'auth.json', False), (store / 'config.toml', False), (store / 'skills/SKILL.md', False),
             (store / 'sibling', False), (store / 'new-home-file', False), (store / 'tmp/sibling', False),
             (fixture / 'outside', False), (store / 'tmp/arg0/redirect', False)]
    checks = [dict(probe(policy, p), expected_allowed=allow) for p, allow in cases]
    (store / 'installation_id').unlink()  # Synthetic fixture controller only.
    checks.append(dict(probe(policy, store / 'installation_id'), expected_allowed=True, condition='literal creation'))
    checks.append(dict(probe(policy, store / 'tmp/arg0/new-dir', 'mkdir'), expected_allowed=True))
    for parent in [store, store / 'tmp']:
        checks.append(dict(probe(policy, parent, 'chmod'), expected_allowed=False))
    checks.append(dict(probe(policy, store / 'tmp/arg0/hardlink', 'link', store / 'auth.json'), expected_allowed=False))
    checks.append(dict(probe(policy, store / 'tmp/arg0/new-alias', 'symlink', fixture / 'synthetic-executable'), expected_allowed=True))
    ok = all(c['exit_code'] == (0 if c['expected_allowed'] else 13) for c in checks)
    return {'status': 'PASS' if ok else 'BLOCKED', 'checks': checks, 'synthetic_profile_digest': hashlib.sha256(policy.encode()).hexdigest()}


def guarded_native(value, argv):
    # No env boolean/claimed evidence enables unrestricted execution. Recheck actual
    # enforcement using the exact policy bytes, then sandbox-exec applies those same
    # bytes before executing any native child. A failed apply never launches Codex.
    outer, store, pins = validate_binding(value)
    outer_pin = directory(outer)
    if not argv or Path(argv[0]).name != 'codex':
        raise ValueError('Only the selected Codex executable is supported')
    if argv[1:] != ['--version']:
        required = ['--ignore-user-config', '--ignore-rules']
        pairs = [('--sandbox', 'danger-full-access'), ('-c', 'approval_policy="never"'), ('-c', 'approvals_reviewer="user"')]
        if (argv[1:2] != ['exec'] or any(flag not in argv for flag in required)
                or argv.count('--sandbox') != 1
                or any(sum(argv[i:i+2] == [a, b] for i in range(len(argv)-1)) != 1 for a, b in pairs)
                or any(arg in ['--dangerously-bypass-approvals-and-sandbox', '--full-auto', '-a', '--ask-for-approval'] for arg in argv)
                or sum(arg.startswith('approval_policy=') for arg in argv) != 1
                or sum(arg.startswith('approvals_reviewer=') for arg in argv) != 1):
            raise ValueError('Exact headless never-approval external enforcement argv required')
    policy = profile(outer, store)
    evidence = synthetic_controls(outer)
    # Verify actual profile too, without a write probe against any real store path.
    outside = Path(tempfile.mkdtemp(prefix='leo-p2-seatbelt-actual-negative-', dir='/private/tmp')).resolve()
    actual = [dict(probe(policy, outer / 'actual-profile-probe'), expected_allowed=True),
              dict(probe(policy, outside / 'denied'), expected_allowed=False)]
    evidence.update(binding=value, actual_profile_checks=actual,
                    outside_root_writes='Two explicit profile bookkeeping exceptions; no zero-outside-write claim')
    if any(c['exit_code'] != (0 if c['expected_allowed'] else 13) for c in actual):
        evidence['status'] = 'BLOCKED'
    log = outer / ('guard-' + uuid.uuid4().hex + '.json')
    log.write_text(json.dumps(evidence, indent=2) + '\n')
    if evidence['status'] != 'PASS':
        raise ValueError('Outer Seatbelt enforcement not verified; no native child: ' + str(log))
    if validate_store(store) != pins or directory(outer) != outer_pin:
        raise ValueError('Selected exception parent or outer root identity changed')
    os.execv('/usr/bin/sandbox-exec', ['/usr/bin/sandbox-exec', '-p', policy, *argv])


def main():
    os.umask(0o077)
    if len(sys.argv) > 2 and sys.argv[1] == '--guarded-native':
        guarded_native(json.loads(sys.argv[2]), sys.argv[3:])
        return
    raise ValueError('Artifact-local qualification guard; only explicit --guarded-native supported')

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('BLOCKED:', str(error), file=sys.stderr)
        raise SystemExit(2)
