import json,sqlite3,sys,os
H=os.environ['QOOPIA_EVAL_DIR']+'/harness'
db=sqlite3.connect('file:'+os.environ['QOOPIA_EVAL_DIR']+'/snap.db?mode=ro',uri=True)
modes=[m for m in ('hybrid','deep','deep_llm') if os.path.exists(f'{H}/raw-{m}.json')]
raw={m:{r['id']:r['ids'] for r in json.load(open(f'{H}/raw-{m}.json'))['rows']} for m in modes}
gold=[json.loads(l) for l in open(f'{H}/golden.jsonl')]
sel=sys.argv[1].split(',') if len(sys.argv)>1 else None
k=int(sys.argv[2]) if len(sys.argv)>2 else 5
for c in gold:
  if c['category']!='log_real' or (sel and c['id'] not in sel): continue
  print('##',c['id'],c['query'])
  pool=[]
  for m in modes:
    for i in raw[m].get(c['id'],[])[:k]:
      if i not in pool: pool.append(i)
  for i in pool:
    r=db.execute("select type,coalesce(subject_key,''),replace(replace(substr(text,1,170),char(10),' '),char(13),' '),valid_until is not null from notes where id=?",(i,)).fetchone()
    tag=''.join(m[0] for m in modes if i in raw[m].get(c['id'],[])[:k])
    print(f' {i} {tag} {r[0][:4]} {r[1][:40]} | {r[2]}' + (' [VU]' if r[3] else ''))
