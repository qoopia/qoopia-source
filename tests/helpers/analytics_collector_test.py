import unittest,tempfile,pathlib,importlib.util,sqlite3,json,sys,subprocess
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('analytics',pathlib.Path(__file__).resolve().parents[2]/'scripts/analytics.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CollectorTest(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.s=m.Store(self.root/'analytics.sqlite')
 def tearDown(self):self.s.db.close();self.temp.cleanup()
 def test_counter_baseline_reset_and_dedup(self):
  for hour,n in [(0,15),(1,17),(2,1)]:self.s.observe('github','downloads',n,{},'cumulative',f'2026-09-13T0{hour}:00:00+00:00')
  self.s.observe('github','downloads',17,{},'cumulative','2026-09-13T01:00:00+00:00')
  rows=self.s.db.execute('SELECT delta,quality FROM cumulative_deltas ORDER BY bucket').fetchall()
  self.assertEqual([tuple(r) for r in rows],[(None,'baseline'),(2.0,'observed_interval'),(None,'reset')])
 def test_failure_does_not_create_false_zero_or_partial_success(self):
  def bad():self.s.observe('broken','partial',3);raise RuntimeError('token=SHOULD_NOT_BE_STORED')
  self.assertFalse(self.s.run('broken',bad));self.assertEqual(self.s.db.execute('select count(*) from observations').fetchone()[0],0)
  self.assertEqual(self.s.db.execute('select error_code from source_runs').fetchone()[0],'RuntimeError')
  self.assertNotIn('SHOULD_NOT',json.dumps(self.s.export()))
 def test_event_cursor_handles_equal_timestamps_and_repeated_import(self):
  db=sqlite3.connect(self.root/'events.sqlite');db.execute('create table analytics_events(id TEXT PRIMARY KEY,received_at INTEGER,source TEXT,kind TEXT,data TEXT)')
  db.executemany('insert into analytics_events values (?,1000,?,?,?)',[(str(i),'server','profile_login','{}') for i in range(10005)]);db.commit();db.close()
  m.import_events(self.s,self.root/'events.sqlite');m.import_events(self.s,self.root/'events.sqlite')
  self.assertEqual(self.s.db.execute('select count(*) from events').fetchone()[0],10005)
 def test_stale_bridge_does_not_block_export_or_backup(self):
  stale=self.root/'stale.json';stale.write_text(json.dumps({'format':'qoopia-provider-metrics/1','observed_at':'2020-01-01T00:00:00+00:00','sources':{}}))
  report=self.root/'latest.json';backup=self.root/'backups'
  r=subprocess.run([sys.executable,str(pathlib.Path(m.__file__)),'--db',str(self.root/'second.sqlite'),'--provider-import',str(stale),'--export',str(report),'--backup-directory',str(backup)],capture_output=True)
  self.assertEqual(r.returncode,1);self.assertTrue(report.exists());self.assertEqual(len(list(backup.glob('*.sqlite'))),1)
  runs={r['source']:r['status'] for r in json.loads(report.read_text())['source_runs']};self.assertEqual(runs,{'provider_bridge':'error','analytics_backup':'ok'})
 def test_metric_values_and_readonly_source(self):
  for value in [-1,float('nan'),float('inf'),'3',True]:
   with self.assertRaises(ValueError):self.s.observe('bad','bad',value)
  db=sqlite3.connect(self.root/'source.sqlite');db.execute('create table x(n)');db.commit();db.close()
  source=m.readonly(self.root/'source.sqlite')
  with self.assertRaises(sqlite3.OperationalError):source.execute('insert into x values(1)')
  source.close()
if __name__=='__main__':unittest.main()
