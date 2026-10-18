import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('snapshots', Path(__file__).resolve().parents[1] / 'scripts/sqlite-snapshot-tree.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SQLiteSnapshots(unittest.TestCase):
    def test_db_and_sqlite_with_live_wal_are_verified_and_private(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp, 'source'); root.mkdir()
            stage = Path(temp, 'stage')
            connections = []
            try:
                for name in ('memory.db', 'login.sqlite'):
                    connection = sqlite3.connect(root / name)
                    connections.append(connection)
                    connection.execute('PRAGMA journal_mode=WAL')
                    connection.execute('PRAGMA wal_autocheckpoint=0')
                    connection.execute('CREATE TABLE t(x)')
                    connection.execute("INSERT INTO t VALUES ('in WAL')")
                    connection.commit()
                (root / 'linked.db').symlink_to(root / 'memory.db')
                self.assertEqual(mod.snapshots([root], stage), (2, 0))
                for target in stage.iterdir():
                    with sqlite3.connect(target) as db:
                        self.assertEqual(db.execute('SELECT x FROM t').fetchone()[0], 'in WAL')
                    self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                (root / 'broken.sqlite').write_text('not a database')
                self.assertEqual(mod.snapshots([root], stage), (2, 1))
            finally:
                for connection in connections:
                    connection.close()


if __name__ == '__main__':
    unittest.main()
