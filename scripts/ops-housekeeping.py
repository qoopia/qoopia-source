#!/usr/bin/env python3
"""Host housekeeping for a Qoopia server. Stdlib only; every destructive action is a dry run unless --apply.

  snapshot SRC DST           consistent copy of a live SQLite database (WAL included) via the backup API;
                             prints {"sha256", "bytes"}; DST is a self-contained rollback-journal file, 0600.
  private [--apply] PATH...  remove group/other permission bits: files keep only owner bits, directories become 0700.
  prune --keep N --max-age-days D [--protect NAME]... [--apply] DIR GLOB...
                             delete matching entries of DIR older than D days, always keeping the newest N and
                             every protected name (for example the current and public release).
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys


def snapshot(source, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = destination.with_name(destination.name + '.tmp')
    temp.unlink(missing_ok=True)
    src = sqlite3.connect('file:' + str(Path(source).resolve()) + '?mode=ro', uri=True, timeout=30)
    dst = sqlite3.connect(temp)
    try:
        src.backup(dst)
        # The copy inherits WAL mode; fold it into the file so the copy is one self-contained file.
        dst.execute('PRAGMA journal_mode=DELETE')
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('snapshot integrity check failed')
    finally:
        dst.close()
        src.close()
    os.chmod(temp, 0o600)
    temp.replace(destination)
    digest = hashlib.sha256()
    with open(destination, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            digest.update(block)
    return {'sha256': digest.hexdigest(), 'bytes': destination.stat().st_size}


def private(paths, apply):
    """(path, old_mode, new_mode) for every entry that is readable or writable beyond its owner."""
    changes = []

    def fix(path, directory):
        mode = stat.S_IMODE(os.lstat(path).st_mode)
        wanted = 0o700 if directory else mode & 0o700
        if mode != wanted:
            changes.append((str(path), oct(mode), oct(wanted)))
            if apply:
                os.chmod(path, wanted)
    for root in map(Path, paths):
        if root.is_symlink() or not root.exists():
            continue
        fix(root, root.is_dir())
        if root.is_dir():
            for dirpath, dirnames, filenames in os.walk(root):
                for name in dirnames + filenames:
                    entry = Path(dirpath, name)
                    if not entry.is_symlink():
                        fix(entry, entry.is_dir())
    return changes


def prune(directory, patterns, keep, max_age_days, protect=(), apply=False, now=None):
    """Names that are (or would be) removed: older than max_age_days, beyond the newest `keep`, not protected."""
    now = now or datetime.datetime.now().timestamp()
    entries = sorted({p for pattern in patterns for p in Path(directory).glob(pattern)}, key=lambda p: os.lstat(p).st_mtime, reverse=True)
    doomed = [p for p in entries[keep:] if p.name not in protect and now - os.lstat(p).st_mtime > max_age_days * 86400]
    if apply:
        for p in doomed:
            shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()
    return [p.name for p in doomed]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    s = sub.add_parser('snapshot')
    s.add_argument('source')
    s.add_argument('destination')
    v = sub.add_parser('private')
    v.add_argument('--apply', action='store_true')
    v.add_argument('paths', nargs='+')
    r = sub.add_parser('prune')
    r.add_argument('--keep', type=int, required=True)
    r.add_argument('--max-age-days', type=float, required=True)
    r.add_argument('--protect', action='append', default=[])
    r.add_argument('--apply', action='store_true')
    r.add_argument('directory')
    r.add_argument('patterns', nargs='+')
    a = p.parse_args(argv)
    os.umask(0o077)
    if a.command == 'snapshot':
        result = snapshot(a.source, a.destination)
    elif a.command == 'private':
        result = {'applied': a.apply, 'changes': private(a.paths, a.apply)}
    else:
        if a.keep < 1:
            p.error('--keep must be at least 1')
        result = {'applied': a.apply, 'removed' if a.apply else 'would_remove': prune(a.directory, a.patterns, a.keep, a.max_age_days, a.protect, a.apply)}
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
