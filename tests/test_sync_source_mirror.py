import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sync_source_mirror', Path(__file__).resolve().parents[1] / 'scripts/sync-source-mirror.py')
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def refs(repo):
    return git('-C', str(repo), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags').splitlines()


class SyncSourceMirrorTests(unittest.TestCase):
    def test_mirror_converges_on_upstream_deletions(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin, copy = Path(tmp, 'work'), Path(tmp, 'origin.git'), Path(tmp, 'mirror.git')
            git('init', '-q', '-b', 'main', str(work))
            git('-C', str(work), '-c', 'user.email=a@example.test', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init')
            git('-C', str(work), 'branch', 'v2-legacy')
            git('-C', str(work), 'tag', 'old-release')
            git('clone', '-q', '--bare', str(work), str(origin))
            git('clone', '-q', '--bare', str(origin), str(copy))
            self.assertEqual(mirror.sync(copy)['status'], 'OK')
            git('-C', str(origin), 'branch', '-q', '-D', 'v2-legacy')
            git('-C', str(origin), 'tag', '-d', 'old-release')
            self.assertEqual(mirror.sync(copy)['status'], 'OK')
            self.assertEqual(refs(copy), refs(origin))


if __name__ == '__main__':
    unittest.main()
