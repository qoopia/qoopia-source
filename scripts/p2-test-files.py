"""Additional isolation diagnostics; never relabels the required full bun test gate.
Every test file is attempted with its own DB/preload and a 25-second process limit.
"""
import os,pathlib,subprocess,time,json,signal,concurrent.futures,tempfile
root=pathlib.Path.cwd();out=root/'artifacts/p2/test-files';out.mkdir(parents=True,exist_ok=True)
files=sorted(str(p) for p in (root/'tests').glob('*.test.ts'))
def run(file):
 start=time.time();name=pathlib.Path(file).name
 with tempfile.TemporaryDirectory(prefix='p2-gate-') as tmp,(out/(name+'.log')).open('w') as log:
  env={'PATH':os.environ['PATH'],'HOME':tmp,'TMPDIR':tmp,'NODE_ENV':'test','P2_EVIDENCE_DIR':str(out)}
  child=subprocess.Popen(['bun','test',file],stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
  try:code=child.wait(25)
  except subprocess.TimeoutExpired:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(2)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
   code=124;log.write('\nTIMEOUT: NOT PASS\n')
 return {'file':str(pathlib.Path(file).relative_to(root)),'exit_code':code,'start':start,'end':time.time()}
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for result in pool.map(run,files):
  results.append(result);(out/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(result['file'],result['exit_code'],flush=True)
