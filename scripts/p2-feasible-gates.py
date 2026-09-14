"""Run every non-socket test file plus the fixed CLI integration on the final sources.
The excluded files and the required full-suite failure remain in evidence, never PASS.
"""
import json,pathlib,os,subprocess,tempfile,time,signal
root=pathlib.Path.cwd();out=pathlib.Path(tempfile.mkdtemp(prefix='feasible-gates-',dir=root/'artifacts/p2'));print('Evidence:',out,flush=True)
prior=json.loads((root/'artifacts/p2/test-files/results.json').read_text());blocked={r['file'] for r in prior if r['exit_code']!=0 and r['file']!='tests/p1-cli.test.ts'}
files=sorted(str(p.relative_to(root)) for p in (root/'tests').glob('*.test.ts') if str(p.relative_to(root)) not in blocked)
(out/'excluded-socket-files.json').write_text(json.dumps(sorted(blocked),indent=2)+'\n')
results=[]
with tempfile.TemporaryDirectory(prefix='p2-final-') as tmp:
 env={'PATH':os.environ['PATH'],'HOME':tmp,'TMPDIR':tmp,'NODE_ENV':'test','P2_EVIDENCE_DIR':str(out)}
 for name,cmd in [('frozen-install',['bun','install','--frozen-lockfile']),('typecheck',['bun','run','typecheck']),('lint',['bun','run','lint']),('lint-v41',['bun','run','lint:v41']),('feasible-test',['bun','test',*files]),('agent-paths',['bun','run','ops:validate-agent-paths','--','--workspace','.','--instruction','CLAUDE.md']),('native-prepare',['bun','scripts/p2-qualify-native.ts','--root',tmp,'--runtime','both','--auth-mode','subscription','--codex-model','gpt-6-astra','--codex-effort','high','--claude-model','claude-opus-5','--claude-effort','high'])]:
  started=time.time()
  with (out/(name+'.log')).open('w') as log:
   p=subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   try:code=p.wait(60)
   except subprocess.TimeoutExpired:
    os.killpg(p.pid,signal.SIGTERM)
    try:p.wait(3)
    except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    code=124
  results.append({'name':name,'argv':cmd,'exit_code':code,'started_at':started,'ended_at':time.time()});(out/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(name,code,flush=True)
