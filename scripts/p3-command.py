"""Run one deterministic local command with isolated HOME/config and durable exit-code evidence."""
import os,sys,pathlib,tempfile,subprocess,time,json,hashlib,signal
root=pathlib.Path.cwd();out=root/'artifacts/p3';out.mkdir(parents=True,exist_ok=True)
arguments=sys.argv[1:];claude_env=bool(arguments and arguments[0]=='--claude-subscription-env')
if claude_env:arguments=arguments[1:]
name=arguments[0];argv=arguments[1:]
if not name.replace('-','').replace('_','').isalnum():raise SystemExit('invalid evidence name')
if claude_env:
 if argv[:3]!=['bun','--no-env-file','scripts/p3-installed-native-check.ts'] or '--execute-real-native' not in argv or argv.count('--claude-auth-mode')!=1:
  raise SystemExit('Claude env forwarding requires the explicit installed native subscription controller')
 index=argv.index('--claude-auth-mode')
 if index+1>=len(argv) or argv[index+1]!='subscription' or '--claude-login-store' in argv:
  raise SystemExit('Claude env forwarding requires subscription without a login store')
 if not os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'):raise SystemExit('Selected Claude subscription environment unavailable; no fallback')
def sources():
 source={}
 for folder in ['src','scripts','migrations','tests']:
  for p in sorted((root/folder).rglob('*')):
   if p.is_file() and '__pycache__' not in str(p):source[str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
 for f in ['package.json','bun.lock','bunfig.toml']:
  source[f]=hashlib.sha256((root/f).read_bytes()).hexdigest()
 return source
source=sources()
manifest=json.dumps(source,sort_keys=True).encode();digest=hashlib.sha256(manifest).hexdigest();(out/(name+'-source.json')).write_bytes(manifest)
with tempfile.TemporaryDirectory(prefix='qoopia-p3-exec-') as tmp:
 env={'PATH':os.environ['PATH'],'HOME':tmp,'TMPDIR':tmp,'XDG_CONFIG_HOME':tmp,'XDG_CACHE_HOME':tmp,'XDG_DATA_HOME':tmp,'NODE_ENV':'test','QOOPIA_DATA_DIR':tmp+'/data','QOOPIA_LOG_DIR':tmp+'/logs','QOOPIA_BACKUP_DIR':tmp+'/backups','QOOPIA_SERVER_ROLE':'canonical','P3_EVIDENCE_DIR':str(out)}
 # Explicit one-variable in-memory forwarding only. Never serialize/hash its value or inherit other auth.
 if claude_env:env['CLAUDE_CODE_OAUTH_TOKEN']=os.environ['CLAUDE_CODE_OAUTH_TOKEN']
 start=time.time()
 with (out/(name+'.log')).open('w') as log:
  p=subprocess.Popen(argv,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(int(os.environ.get('P3_COMMAND_TIMEOUT','1800')))
  except subprocess.TimeoutExpired:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(3)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   code=124
 after=sources();changed=sorted(k for k in source.keys()|after.keys() if source.get(k)!=after.get(k))
 result={'name':name,'argv':argv,'exit_code':code,'started_at':start,'ended_at':time.time(),'source_manifest_sha256':digest,'source_changed_during_execution':changed,'log_sha256':hashlib.sha256((out/(name+'.log')).read_bytes()).hexdigest(),'platform':sys.platform,'fixture_only':True}
 if claude_env:result['selected_auth_environment']='CLAUDE_CODE_OAUTH_TOKEN'
 (out/(name+'-result.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));print((out/(name+'.log')).read_text()[-5000:])
 sys.exit(code)
