#!/usr/bin/env python3
"""Refresh the existing private bare mirror using its existing operator credential."""
import argparse
import json
from pathlib import Path
import subprocess
import time


def sync(path):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.DEVNULL, timeout=90, text=True).strip()
    if git('rev-parse', '--is-bare-repository') != 'true':
        raise ValueError('Only a bare mirror may be synced')
    git('fetch', 'origin', '+refs/heads/*:refs/heads/*', '--tags')
    local = git('rev-parse', 'refs/heads/main')
    remote = git('ls-remote', 'origin', 'refs/heads/main').split()[0]
    if local != remote:
        raise ValueError('Remote moved during fetch; next run will retry')
    return {'status': 'OK', 'checked_at': time.time(), 'remote_main': remote}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mirror', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = sync(args.mirror)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        result = {'status': 'ERROR', 'checked_at': time.time()}
    temp = args.mirror / 'sync-status.tmp'
    temp.write_text(json.dumps(result) + '\n')
    temp.replace(args.mirror / 'sync-status.json')
    print(json.dumps(result))
    raise SystemExit(0 if result['status'] == 'OK' else 1)
