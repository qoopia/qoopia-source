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
            self.assertEqual(mirror.sync(copy, None)['status'], 'OK')
            git('-C', str(origin), 'branch', '-q', '-D', 'v2-legacy')
            git('-C', str(origin), 'tag', '-d', 'old-release')
            self.assertEqual(mirror.sync(copy, None)['status'], 'OK')
            self.assertEqual(refs(copy), refs(origin))

    def test_release_consumer_follows_the_same_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin, copy, consumer = Path(tmp, 'work'), Path(tmp, 'origin.git'), Path(tmp, 'mirror.git'), Path(tmp, 'consumer')
            commit = ('-c', 'user.email=a@example.test', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m')
            git('init', '-q', '-b', 'main', str(work))
            git('-C', str(work), *commit, 'init')
            git('clone', '-q', '--bare', str(work), str(origin))
            git('clone', '-q', '--bare', str(origin), str(copy))
            git('clone', '-q', str(origin), str(consumer))
            git('-C', str(work), *commit, 'next')
            git('-C', str(work), 'push', '-q', str(origin), 'main')
            result = mirror.sync(copy, consumer)
            head = git('-C', str(origin), 'rev-parse', 'refs/heads/main')
            self.assertEqual((result['remote_main'], result['mirror_main'], result['consumer_main']), (head, head, head))
            # A consumer that tracks some other repository is a disagreement, never OK.
            other = Path(tmp, 'other.git')
            git('clone', '-q', '--bare', str(origin), str(other))
            git('-C', str(consumer), 'remote', 'set-url', 'origin', str(other))
            git('-C', str(work), *commit, 'third')
            git('-C', str(work), 'push', '-q', str(origin), 'main')
            with self.assertRaises(ValueError):
                mirror.sync(copy, consumer)


if __name__ == '__main__':
    unittest.main()
