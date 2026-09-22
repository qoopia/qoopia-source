import importlib.util, json, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('discovery',ROOT/'scripts/discovery-audit.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class DiscoveryTests(unittest.TestCase):
 def test_denies_unlisted_url_before_network(self):
  with self.assertRaises(ValueError):m.fetch('https://qoopia.ai/private',Path('/unused'))
 def test_unavailable_is_not_pass(self):
  self.assertEqual(m.inspect('home',None,{'http_status':403})[0]['code'],'FETCH_UNAVAILABLE')
 def test_stale_source_claim_and_noindex_detected(self):
  text='<title>Qoopia</title><meta name="description" content="Test"><meta name="robots" content="noindex"><link rel="canonical" href="https://qoopia.ai/"><h1>Qoopia</h1>/understand product source repository remains private'
  self.assertEqual({x['code'] for x in m.inspect('home',text,{})},{'FALSE_PRIVATE_SOURCE','NOINDEX'})
 def test_current_pages(self):
  for key in ('home','docs','releases','understand','understand-ru','mobile'):
   file='index' if key=='home' else key
   self.assertEqual(m.inspect(key,(ROOT/f'marketing-site/{file}.html').read_text(),{}),[],key)
 def test_current_sitemap_and_unexpected_extra(self):
  xml=(ROOT/'marketing-site/sitemap.xml').read_text()
  self.assertEqual(m.inspect('sitemap',xml,{}),[])
  extra=xml.replace('</urlset>','<url><loc>https://qoopia.ai/unreviewed</loc></url></urlset>')
  self.assertEqual(m.inspect('sitemap',extra,{})[0]['code'],'SITEMAP_ROUTES')
 def test_sitemap_rejects_private_or_extra_routes(self):
  xml='<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://auth.qoopia.ai/owner</loc></url></urlset>'
  self.assertEqual(m.inspect('sitemap',xml,{})[0]['code'],'SITEMAP_ROUTES')
 def test_fetch_does_not_follow_redirect_or_save_body(self):
  from unittest.mock import patch
  import subprocess
  with tempfile.TemporaryDirectory() as d:
   target=Path(d)/'response'
   def fake(args,**kwargs):
    self.assertNotIn('--location',args);self.assertIn('--max-filesize',args)
    Path(args[args.index('--output')+1]).write_text('private body')
    return subprocess.CompletedProcess(args,0,'302','')
   with patch.object(m.subprocess,'run',fake):record,text=m.fetch(m.URLS['home'],target)
   self.assertIsNone(text);self.assertFalse(target.exists());self.assertEqual(record['http_status'],302)
if __name__=='__main__':unittest.main()
