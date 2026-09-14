#!/usr/bin/env python3
"""Owner-only GitHub metadata. No code, bodies, logs, emails or credentials exported."""
import concurrent.futures,datetime,json,re,subprocess

def collect(gh):
 def api(path):
  result=subprocess.run([gh,'api',path,'-H','Accept: application/vnd.github+json'],capture_output=True,text=True,timeout=25)
  if result.returncode:
   code=re.search(r'HTTP (\d{3})',result.stderr)
   raise RuntimeError('HTTP_'+code.group(1) if code else 'API_UNAVAILABLE')
  if len(result.stdout)>8_000_000:raise RuntimeError('RESPONSE_LIMIT')
  return json.loads(result.stdout)
 def pages(path,key=None,limit=10):
  rows=[]
  for page in range(1,limit+1):
   data=api(path+('&' if '?' in path else '?')+f'per_page=100&page={page}')
   batch=data[key] if key else data
   if not isinstance(batch,list):raise RuntimeError('INVALID_RESPONSE')
   rows.extend(batch)
   if len(batch)<100:return rows,False
  return rows,True
 def login(item):return (item.get('user') or item.get('owner') or {}).get('login')
 def keep(item,fields):return {k:item.get(k) for k in fields.split()}
 def dataset(fn):
  try:return {'status':'ok','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),**fn()}
  except Exception as exc:return {'status':'unavailable','error':str(exc) if str(exc).startswith(('HTTP_','API_','RESPONSE_','INVALID_')) else type(exc).__name__}
 def listing(path,fields,who=False,key=None,limit=10):
  rows,capped=pages(path,key,limit)
  return {'items':[{**keep(r,fields),**({'account':login(r)} if who else {})} for r in rows],'truncated':capped}
 inventory=subprocess.run([gh,'repo','list','qoopia','--limit','1000','--json','nameWithOwner,isPrivate,isArchived,url'],capture_output=True,text=True,timeout=25)
 if inventory.returncode:raise RuntimeError('INVENTORY_UNAVAILABLE')
 repos=json.loads(inventory.stdout)
 if len(repos)>=1000:raise RuntimeError('INVENTORY_LIMIT')
 results=[]
 for repository in repos:
  name=repository['nameWithOwner']
  if not re.fullmatch(r'qoopia/[A-Za-z0-9_.-]+',name):raise RuntimeError('REPOSITORY_OUTSIDE_SCOPE')
  base='repos/'+name
  def issues():
   rows,capped=pages(base+'/issues?state=all&sort=updated&direction=desc')
   return {'items':[{**keep(r,'number title state state_reason html_url created_at updated_at closed_at comments'), 'account':login(r),'kind':'pull_request' if 'pull_request' in r else 'issue','labels':[x['name'] for x in r.get('labels',[])], 'assignees':[x['login'] for x in r.get('assignees',[])]} for r in rows],'truncated':capped}
  def releases():
   rows,capped=pages(base+'/releases')
   return {'items':[{**keep(r,'id tag_name name html_url draft prerelease created_at published_at'),'account':login(r),'assets':[{**keep(a,'id name size download_count created_at updated_at browser_download_url')} for a in r.get('assets',[])]} for r in rows],'truncated':capped}
  def pulls():
   rows,capped=pages(base+'/pulls?state=all&sort=updated&direction=desc')
   return {'items':[{**keep(r,'number title state html_url created_at updated_at closed_at merged_at draft'),'account':login(r)} for r in rows],'truncated':capped}
  jobs={
   'repository':lambda:{'data':keep(api(base),'full_name private archived disabled stargazers_count forks_count subscribers_count open_issues_count size created_at updated_at pushed_at default_branch has_issues has_discussions')},
   'issues':issues,'pull_requests':pulls,'releases':releases,
   'forks':lambda:listing(base+'/forks?sort=newest','full_name html_url created_at pushed_at',True),
   'stargazers':lambda:listing(base+'/stargazers','login html_url'),
   'watchers':lambda:listing(base+'/subscribers','login html_url'),
   'contributors':lambda:listing(base+'/contributors','login html_url contributions type'),
   'branches':lambda:listing(base+'/branches','name protected'),
   'tags':lambda:listing(base+'/tags','name'),
   'languages':lambda:{'data':api(base+'/languages')},
   'community':lambda:{'data':keep(api(base+'/community/profile'),'health_percentage description updated_at')},
   'actions':lambda:listing(base+'/actions/runs','id name html_url event status conclusion created_at updated_at run_attempt head_branch','',key='workflow_runs',limit=1),
   'milestones':lambda:listing(base+'/milestones?state=all','number title state html_url open_issues closed_issues due_on'),
   'labels':lambda:listing(base+'/labels','name description color'),
  }
  for endpoint in ['views','clones','popular/paths','popular/referrers']:
   def traffic(endpoint=endpoint):
    raw=api(base+'/traffic/'+endpoint)
    if endpoint in ('views','clones'):return {'data':raw}
    return {'items':[{**{k:v for k,v in row.items() if k in ('count','uniques','referrer')},**({'path':row['path'].split('?')[0].split('#')[0]} if 'path' in row else {})} for row in raw]}
   jobs['traffic_'+endpoint.replace('/','_')]=traffic
  # Recent public activity metadata only. Event payloads may contain bodies: discard them.
  def events():
   rows,capped=pages(base+'/events',limit=1)
   return {'items':[{'id':r['id'],'type':r['type'],'created_at':r['created_at'],'account':r['actor']['login']} for r in rows],'truncated':capped,'window':'GitHub retained recent events; not complete history'}
  jobs['events']=events
  def discussions():
   query='query { repository(owner:"qoopia", name:'+json.dumps(name.split('/')[1])+') { discussions(first:100, orderBy:{field:UPDATED_AT,direction:DESC}) { totalCount pageInfo { hasNextPage } nodes { number title url createdAt updatedAt isAnswered author { login } comments { totalCount } } } } }'
   r=subprocess.run([gh,'api','graphql','-f','query='+query],capture_output=True,text=True,timeout=25)
   if r.returncode:raise RuntimeError('API_UNAVAILABLE')
   data=json.loads(r.stdout)
   if data.get('errors'):raise RuntimeError('API_UNAVAILABLE')
   d=data['data']['repository']['discussions']
   return {'items':[{'number':x['number'],'title':x['title'],'html_url':x['url'],'created_at':x['createdAt'],'updated_at':x['updatedAt'],'answered':x['isAnswered'],'account':(x['author'] or {}).get('login'),'comments':x['comments']['totalCount']} for x in d['nodes']],'total_count':d['totalCount'],'truncated':d['pageInfo']['hasNextPage']}
  jobs['discussions']=discussions
  def commits():
   rows,capped=pages(base+'/commits',limit=1)
   return {'items':[{'sha':x['sha'],'html_url':x['html_url'],'account':(x.get('author') or {}).get('login'),'created_at':x['commit']['committer']['date']} for x in rows],'truncated':capped,'window':'Latest 100 commits'}
  jobs['commits']=commits
  with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
   futures={key:pool.submit(dataset,fn) for key,fn in jobs.items()}
   data={key:f.result() for key,f in futures.items()}
  results.append({**repository,'datasets':data})
 return {'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'repositories':results,'scope':'All repositories visible to this operator under qoopia; private metadata is owner-only','limits':['Clone/download identities, operating systems, geography and local code usage are not supplied by GitHub.','Source ZIP/tar archive downloads have no counter. Release assets have separate file counters.','Traffic is a rolling 14-day window. Unique counts must not be summed across days or repositories.','Discussion bodies, comments, code, CI logs, security reports and private user data are not collected.']}
