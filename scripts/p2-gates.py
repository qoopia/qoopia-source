import os,subprocess,time,json,pathlib,signal
root=pathlib.Path.cwd();out=root/'artifacts/p2/gates';out.mkdir(exist_ok=True)
tmp=pathlib.Path('/tmp/qoopia-p2-gates-final');tmp.mkdir(exist_ok=True)
env={'PATH':os.environ['PATH'],'HOME':str(tmp),'TMPDIR':str(tmp),'NODE_ENV':'test','P2_EVIDENCE_DIR':str(out)}
results=[]
for name,cmd,limit in [('frozen-install',['bun','install','--frozen-lockfile'],60),('typecheck',['bun','run','typecheck'],60),('lint',['bun','run','lint'],60),('lint-v41',['bun','run','lint:v41'],60),('full-test',['bun','test'],180),('agent-paths',['bun','run','ops:validate-agent-paths','--','--workspace','.','--instruction','CLAUDE.md'],60)]:
 start=time.time()
 with (out/(name+'.log')).open('w') as log:
  p=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
  try:code=p.wait(limit)
  except subprocess.TimeoutExpired:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(3)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   code=124;log.write('\nTIMEOUT: bounded runner terminated this gate; NOT PASS.\n')
 results.append({'gate':name,'argv':cmd,'started_at':start,'ended_at':time.time(),'exit_code':code})
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name,code,flush=True)
