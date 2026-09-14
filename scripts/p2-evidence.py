"""Redact local operator path prefixes and hash the final implementation/evidence.
No credentials or source payloads are collected. Rerun after final tests/docs change.
"""
import pathlib,hashlib,json,re,subprocess,platform,datetime
root=pathlib.Path.cwd();art=root/'artifacts/p2'
for path in art.rglob('*'):
 if not path.is_file() or path.suffix not in ('.log','.json','.md'):continue
 text=path.read_text()
 text=text.replace(str(root),'[WORKTREE]')
 text=re.sub(r'/Users/[^/\s"\\]+','[USER_HOME]',text)
 text=re.sub(r'/(?:private/)?var/folders/[^/\s]+/[^/\s]+/T','[TMPDIR]',text)
 path.write_text(text)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
files=[]
for directory in ['src','scripts','tests','migrations']:
 files.extend(p for p in (root/directory).rglob('*') if p.is_file() and '__pycache__' not in str(p))
files.extend(root/n for n in ['package.json','bun.lock','bunfig.toml','tsconfig.json'])
manifest={str(p.relative_to(root)):sha(p) for p in sorted(set(files))}
build=hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
(art/'build-manifest.json').write_text(json.dumps({'format':'p2-source-fingerprint/1','build_fingerprint':build,'base_commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'schema':37,'platform':platform.platform(),'files':manifest},indent=2)+'\n')
evidence={str(p.relative_to(root)):sha(p) for p in sorted(art.rglob('*')) if p.is_file() and p.name!='evidence-hashes.json'}
(art/'evidence-hashes.json').write_text(json.dumps({'recorded_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'redaction':'[WORKTREE], [USER_HOME], [TMPDIR] replace local operator path prefixes; synthetic fixture IDs/digests retained','files':evidence},indent=2)+'\n')
print(json.dumps({'build_fingerprint':build,'source_files':len(manifest),'evidence_files':len(evidence)}))
