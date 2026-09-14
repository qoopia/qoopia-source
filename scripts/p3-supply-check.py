"""Exercise the existing vendored advisory gate on local synthetic negative controls."""
import pathlib,tempfile,subprocess,json,hashlib,shutil,os
root=pathlib.Path.cwd();source=(root/'scripts/check-vendored-pdfjs.ts').read_text();results=[]
with tempfile.TemporaryDirectory(prefix='qoopia-p3-supply-') as temp:
 work=pathlib.Path(temp);(work/'scripts').mkdir();package=work/'node_modules/unpdf';(package/'dist').mkdir(parents=True)
 for case,version,pdf,pin,expected in [('current','1.4.0','5.4.296','5.4.296',0),('tampered-pin','1.4.0','5.4.295','5.4.296',1),('vulnerable-even-if-pin-edited','1.4.0','5.6.83','5.6.83',1),('changed-unpdf','1.5.0','5.4.296','5.4.296',1)]:
  script=work/'scripts/check-vendored-pdfjs.ts';script.write_text(source.replace('const EXPECTED_PDFJS = "5.4.296";',f'const EXPECTED_PDFJS = "{pin}";'))
  (package/'package.json').write_text(json.dumps({'version':version}));(package/'dist/pdfjs.mjs').write_text(f'export const version="{pdf}";\n')
  cmd=['bun',str(script)];p=subprocess.run(cmd,capture_output=True,text=True,cwd=work,env={'PATH':os.environ['PATH'],'HOME':temp,'TMPDIR':temp})
  results.append({'case':case,'argv':cmd,'exit_code':p.returncode,'expected':expected,'stderr':p.stderr.strip(),'stdout':p.stdout.strip()});assert p.returncode==expected
print(json.dumps({'status':'PASS_NEGATIVE_CONTROLS','advisory':'GHSA-hq66-cqwq-w95j','advisory_currency':'existing accepted pin; no live advisory database lookup','cases':results},indent=2))
