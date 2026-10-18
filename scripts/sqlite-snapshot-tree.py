#!/usr/bin/env python3
"""Consistent SQLite copies for the existing restic system job; transient WAL/SHM stay out of restic."""
import argparse
from contextlib import closing
import hashlib
import os
from pathlib import Path
import sqlite3
import sys


def snapshots(roots, stage):
    stage = Path(stage)
    stage.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(stage, 0o700)
    count, failures = 0, 0
    for root in roots:
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in ('backups', 'quarantine', 'node_modules', '.git', '.venv') and not Path(directory, d).is_symlink()]
            for name in files:
                source = Path(directory, name)
                if source.suffix not in ('.db', '.sqlite') or source.is_symlink():
                    continue
                try:
                    if source.stat().st_size >= 2 * 1024**3:
                        raise ValueError('database exceeds snapshot bound')
                    target = stage / (hashlib.sha256(str(source).encode()).hexdigest()[:16] + '-' + name + '.snapshot')
                    temp = target.with_suffix('.tmp')
                    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=30)) as live:
                        with closing(sqlite3.connect(temp)) as copied:
                            live.backup(copied)
                            if copied.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                                raise ValueError('integrity failed')
                            copied.execute('PRAGMA journal_mode=DELETE')
                    os.chmod(temp, 0o600)
                    temp.replace(target)
                    count += 1
                except (OSError, sqlite3.Error, ValueError):
                    failures += 1
                    print('SQLite snapshot failed: ' + str(source), file=sys.stderr)
    return count, failures


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('roots', nargs='+')
    args = parser.parse_args()
    count, failures = snapshots(args.roots, args.stage)
    print('SQLite snapshots: %d verified, %d failed' % (count, failures))
    raise SystemExit(1 if failures else 0)
