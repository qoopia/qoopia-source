#!/usr/bin/env python3
"""Qoopia first-party analytical store. Stdlib only; source DBs are read-only."""
import argparse, datetime, hashlib, json, math, os, sqlite3, sys, urllib.request, urllib.error, uuid, subprocess, shutil
from pathlib import Path
UTC=datetime.timezone.utc

def utc():return datetime.datetime.now(UTC).isoformat()
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def readonly(file):
    db=sqlite3.connect('file:'+str(Path(file).resolve())+'?mode=ro',uri=True,timeout=2)
    db.execute('PRAGMA query_only=ON');return db

class Store:
    def __init__(self,file):
        Path(file).parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db=sqlite3.connect(file,timeout=10);self.db.row_factory=sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
        CREATE TABLE IF NOT EXISTS source_runs(id TEXT PRIMARY KEY,source TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,error_code TEXT);
        CREATE TABLE IF NOT EXISTS observations(source TEXT NOT NULL,metric TEXT NOT NULL,dimensions TEXT NOT NULL,bucket TEXT NOT NULL,observed_at TEXT NOT NULL,value REAL NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(source,metric,dimensions,bucket));
        CREATE TABLE IF NOT EXISTS provider_snapshots(source TEXT NOT NULL,observed_at TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(source,observed_at));
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,source TEXT NOT NULL,received_at INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_time ON events(received_at);
        CREATE TABLE IF NOT EXISTS event_cursors(source TEXT PRIMARY KEY,last_rowid INTEGER NOT NULL,last_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,kind TEXT NOT NULL,details TEXT NOT NULL);
        DROP VIEW IF EXISTS event_daily;
        CREATE VIEW event_daily AS SELECT date(received_at/1000,'unixepoch') AS day,source,kind,json_remove(data,'$.duration_ms','$.value') AS dimensions,count(*) AS events,avg(json_extract(data,'$.duration_ms')) AS mean_duration_ms,avg(json_extract(data,'$.value')) AS mean_value FROM events GROUP BY day,source,kind,dimensions;
        CREATE VIEW IF NOT EXISTS latest_observations AS SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY source,metric,dimensions ORDER BY bucket DESC) AS rank FROM observations) WHERE rank=1;
        CREATE VIEW IF NOT EXISTS cumulative_deltas AS SELECT *,CASE WHEN previous_value IS NULL OR value<previous_value THEN NULL ELSE value-previous_value END AS delta,CASE WHEN previous_value IS NULL THEN 'baseline' WHEN value<previous_value THEN 'reset' ELSE 'observed_interval' END AS quality FROM (SELECT *,lag(value) OVER(PARTITION BY source,metric,dimensions ORDER BY bucket) AS previous_value FROM observations WHERE kind='cumulative');
        ''');self.db.commit();os.chmod(file,0o600)
    def observe(self,source,metric,value,dimensions=None,kind='gauge',at=None):
        if not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or value<0:raise ValueError('invalid metric value')
        if kind not in ('gauge','cumulative','period'):raise ValueError('invalid metric kind')
        at=at or utc();parsed=datetime.datetime.fromisoformat(at.replace('Z','+00:00'))
        bucket=parsed.replace(minute=parsed.minute//5*5,second=0,microsecond=0).isoformat()
        self.db.execute('INSERT INTO observations VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,metric,dimensions,bucket) DO UPDATE SET observed_at=excluded.observed_at,value=excluded.value,kind=excluded.kind',(source,metric,canonical(dimensions or {}),bucket,at,value,kind))
    def snapshot(self,source,value,at=None):
        raw=canonical(value);self.db.execute('INSERT OR IGNORE INTO provider_snapshots VALUES (?,?,?,?)',(source,at or utc(),raw,hashlib.sha256(raw.encode()).hexdigest()))
    def run(self,source,fn):
        rid=str(uuid.uuid4());self.db.execute('INSERT INTO source_runs VALUES (?,?,?,NULL,?,NULL)',(rid,source,utc(),'running'));self.db.commit()
        try:
            fn();self.db.execute("UPDATE source_runs SET status='ok',finished_at=? WHERE id=?",(utc(),rid));self.db.commit();return True
        except Exception as e:
            self.db.rollback()
            code='HTTP_'+str(e.code) if isinstance(e,urllib.error.HTTPError) else type(e).__name__
            state='blocked' if isinstance(e,PermissionError) else 'error'
            self.db.execute("UPDATE source_runs SET status=?,finished_at=?,error_code=? WHERE id=?",(state,utc(),code,rid));self.db.commit();return False
    def export(self):
        latest=[dict(r) for r in self.db.execute('SELECT source,metric,dimensions,observed_at,value,kind FROM latest_observations ORDER BY source,metric,dimensions')]
        for r in latest:r['dimensions']=json.loads(r['dimensions'])
        runs=[dict(r) for r in self.db.execute('SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY source ORDER BY started_at DESC) AS rank FROM source_runs) WHERE rank=1')]
        # Duration is a measure, not a grouping dimension; aggregate it separately.
        events=[dict(r) for r in self.db.execute("SELECT date(received_at/1000,'unixepoch') AS day,source,kind,count(*) AS events,avg(json_extract(data,'$.duration_ms')) AS mean_duration_ms FROM events GROUP BY day,source,kind ORDER BY day DESC,source,kind")]
        freshness=[dict(r) for r in self.db.execute('SELECT source,max(observed_at) AS observed_at FROM provider_snapshots GROUP BY source')]
        ecosystem=self.db.execute("SELECT observed_at,payload FROM provider_snapshots WHERE source='github_ecosystem' ORDER BY observed_at DESC LIMIT 1").fetchone()
        github=json.loads(ecosystem['payload']).get('report') if ecosystem else None
        history=[dict(r) for r in self.db.execute("SELECT metric,dimensions,substr(observed_at,1,10) AS day,value FROM (SELECT *,row_number() OVER(PARTITION BY metric,dimensions,substr(observed_at,1,10) ORDER BY observed_at DESC) AS n FROM observations WHERE source='github_ecosystem' AND observed_at>=datetime('now','-90 days')) WHERE n=1 ORDER BY day DESC LIMIT 10000")]
        for r in history:r['dimensions']=json.loads(r['dimensions'])
        return {'github_ecosystem':github,'github_history':history,'provider_freshness':freshness,'generated_at':utc(),'coverage':'Owned services and provider APIs only; independent user installations are not reporting telemetry. Browser events are untrusted counts, not unique users.','latest':latest,'source_runs':runs,'event_daily':events}

def get(url,headers=None):
    req=urllib.request.Request(url,headers={'User-Agent':'Qoopia-Analytics/1','Accept':'application/json',**(headers or {})})
    with urllib.request.urlopen(req,timeout=25) as r:
        raw=r.read(8*1024*1024+1)
        if len(raw)>8*1024*1024:raise ValueError('provider response too large')
        return json.loads(raw)

def github(store,repository):
    if repository!='qoopia/qoopia-downloads':raise ValueError('repository outside analytics scope')
    source='github_releases';safe=[]
    for page in range(1,21):
        releases=get('https://api.github.com/repos/'+repository+'/releases?per_page=100&page='+str(page))
        if not isinstance(releases,list):raise ValueError('invalid releases')
        for r in releases:
            item={k:r[k] for k in ['id','tag_name','draft','prerelease','created_at','published_at']};item['assets']=[]
            for a in r['assets']:
                asset={k:a.get(k) for k in ['id','name','size','content_type','created_at','updated_at','download_count','digest']};item['assets'].append(asset)
                store.observe(source,'asset_downloads',a['download_count'],{'asset_id':a['id'],'file':a['name'],'tag':r['tag_name'],'prerelease':r['prerelease']},'cumulative')
                store.observe(source,'asset_bytes',a['size'],{'asset_id':a['id'],'file':a['name']})
            safe.append(item)
        if len(releases)<100:break
    else:raise ValueError('release pagination limit')
    store.snapshot(source,safe)
    repo=get('https://api.github.com/repos/'+repository)
    public={k:repo[k] for k in ['stargazers_count','forks_count','subscribers_count','open_issues_count','size','created_at','updated_at','pushed_at']}
    store.snapshot('github_repository',public)
    for k in ['stargazers_count','forks_count','subscribers_count','open_issues_count','size']:store.observe('github_repository',k,public[k])

AUTH_QUERIES={
 'accounts':"SELECT count(*) FROM connection_accounts",
 'accounts_google_linked':"SELECT count(*) FROM connection_accounts WHERE google_sub IS NOT NULL",
 'saved_dashboard_profiles':"SELECT count(*) FROM profile_dashboards",
 'profile_sessions_unexpired':"SELECT count(*) FROM profile_sessions WHERE expires>CAST(strftime('%s','now') AS INTEGER)*1000",
 'profile_accounts_with_unexpired_session':"SELECT count(DISTINCT account_id) FROM profile_sessions WHERE expires>CAST(strftime('%s','now') AS INTEGER)*1000",
 'pending_logins':"SELECT count(*) FROM login_requests WHERE expires>CAST(strftime('%s','now') AS INTEGER)*1000",
 'relay_groups_open':"SELECT count(*) FROM bridge_relay_groups WHERE closed_at_ms IS NULL",
 'relay_groups_closed':"SELECT count(*) FROM bridge_relay_groups WHERE closed_at_ms IS NOT NULL",
}
MEMORY_QUERIES={
 'notes_current':"SELECT count(*) FROM notes",'agents_current':"SELECT count(*) FROM agents",'agents_enabled':"SELECT count(*) FROM agents WHERE active=1",
 'agents_seen_24h':"SELECT count(*) FROM agents WHERE last_seen>strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')",
 'agents_seen_7d':"SELECT count(*) FROM agents WHERE last_seen>strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')",
 'oauth_registrations_current':"SELECT count(*) FROM oauth_clients",
 'oauth_clients_with_unexpired_grants':"SELECT count(DISTINCT client_id) FROM oauth_tokens WHERE revoked=0 AND expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')",
 'workspaces_current':"SELECT count(*) FROM workspaces",'schema_version':"SELECT max(version) FROM schema_versions",
 'recall_calls_retained':"SELECT count(*) FROM recall_log",
}

def sql_source(store,file,source):
    db=readonly(file);db.execute('BEGIN')
    try:
        queries=AUTH_QUERIES if source=='account_service' else MEMORY_QUERIES
        for metric,query in queries.items():store.observe(source,metric,db.execute(query).fetchone()[0])
        if source=='account_service':
            tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'news_preferences' in tables:
                store.observe(source,'news_subscribers',db.execute('SELECT count(*) FROM news_preferences p JOIN connection_accounts a ON a.id=p.account_id AND a.email=p.email WHERE p.subscribed=1').fetchone()[0])
                for state in ['sending','accepted','failed','uncertain','skipped']:
                    store.observe(source,'news_deliveries',db.execute('SELECT count(*) FROM news_deliveries WHERE status=?',(state,)).fetchone()[0],{'state':state})
            if 'account_activity' in tables:
                store.observe(source,'signins_recorded',db.execute('SELECT COALESCE(sum(login_count),0) FROM account_activity').fetchone()[0],kind='cumulative')
                store.observe(source,'accounts_registration_unknown',db.execute('SELECT count(*) FROM connection_accounts a LEFT JOIN account_activity x ON x.account_id=a.id WHERE x.registered_at IS NULL').fetchone()[0])
            # Always emit explicit zeros for known states; unknown states are a schema error.
            for state in ['provisioning','active','revoked']:
                store.observe(source,'managed_devices',db.execute('SELECT count(*) FROM connection_devices WHERE state=?',(state,)).fetchone()[0],{'state':state})
            groups=dict(db.execute('SELECT state,count(*) FROM bridge_relay_members GROUP BY state'))
            previous={json.loads(r[0])['state'] for r in store.db.execute("SELECT dimensions FROM latest_observations WHERE source=? AND metric='relay_members'",(source,))}
            for state in set(groups)|previous:store.observe(source,'relay_members',groups.get(state,0),{'state':state})
        else:
            for surface in ['chatgpt_web','chatgpt_desktop','claude_web','claude_desktop','codex','claude_code']:
                for state in ['awaiting_client','verified','revoked']:
                    n=db.execute('SELECT count(*) FROM client_connections WHERE surface=? AND state=?',(surface,state)).fetchone()[0]
                    store.observe(source,'client_connections',n,{'surface':surface,'state':state})
            for mode,count,latency,empty,errors in db.execute("SELECT backend_path,count(*),avg(latency_ms),sum(CASE WHEN result_ids='[]' THEN 1 ELSE 0 END),sum(CASE WHEN error_class IS NOT NULL THEN 1 ELSE 0 END) FROM recall_log WHERE created_at>strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day') GROUP BY backend_path"):
                for metric,value in [('recall_calls_24h',count),('recall_mean_latency_ms_24h',latency),('recall_empty_24h',empty),('recall_errors_24h',errors)]:store.observe(source,metric,value,{'backend':mode})
            # Counts only. No note text, prompts, model outputs or credential fields.
            tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in ['files','entity_pages','skill_captures','skill_assignments','skill_runs','skill_outcomes','runtime_observations','session_loadouts','bridge_groups','bridge_members','memory_sessions']:
                if table in tables:store.observe(source,table+'_current',db.execute('SELECT count(*) FROM "'+table+'"').fetchone()[0])
    finally:db.close()

def import_events(store,file):
    db=readonly(file)
    try:
        cursor=store.db.execute("SELECT last_rowid,last_id FROM event_cursors WHERE source='auth'").fetchone()
        last=cursor[0] if cursor else 0
        if cursor:
            prior=db.execute('SELECT id FROM analytics_events WHERE rowid=?',(last,)).fetchone()
            if not prior or prior[0]!=cursor[1]:last=0
        while True:
            rows=db.execute('SELECT rowid,id,received_at,source,kind,data FROM analytics_events WHERE rowid>? ORDER BY rowid LIMIT 10000',(last,)).fetchall()
            if not rows:break
            for rowid,id,at,source,kind,data in rows:
                store.db.execute('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)',(id,source,at,kind,data))
            last=rows[-1][0]
            store.db.execute("INSERT INTO event_cursors VALUES ('auth',?,?) ON CONFLICT(source) DO UPDATE SET last_rowid=excluded.last_rowid,last_id=excluded.last_id",(last,rows[-1][1]))
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='analytics_daily'").fetchone():
            for day,accepted,dropped in db.execute('SELECT day,accepted,dropped FROM analytics_daily'):
                store.observe('first_party_events','accepted_events',accepted,{'day':day},'cumulative')
                store.observe('first_party_events','dropped_events',dropped,{'day':day},'cumulative')
    finally:db.close()

def provider_file(file):
    data=json.loads(Path(file).read_text())
    # The bridge carries a bounded schema from the local authenticated provider
    # collector. Store metric rows and status, never provider credentials/bodies.
    if set(data)-{'format','observed_at','sources'} or data.get('format')!='qoopia-provider-metrics/1':raise ValueError('invalid provider file')
    age=datetime.datetime.now(UTC)-datetime.datetime.fromisoformat(data['observed_at'].replace('Z','+00:00'))
    if age.total_seconds()>86400 or age.total_seconds() < -300:raise ValueError('stale or future provider file')
    return data

def provider_import(store,file):
    data={}
    if not store.run('provider_bridge',lambda:data.update(provider_file(file))):return False
    for source,item in data['sources'].items():
        if source not in ['github_traffic','github_ecosystem','cloudflare','resend']:raise ValueError('unknown provider')
        def apply():
            if item['status']!='ok':raise PermissionError('provider unavailable')
            for row in item['metrics']:store.observe(source,row['metric'],row['value'],row.get('dimensions'),row.get('kind','gauge'),row.get('at',data['observed_at']))
            if source=='github_ecosystem':
                report=item['report']
                for repository in report['repositories']:
                    name=repository['nameWithOwner'];datasets=repository['datasets']
                    summary=datasets.get('repository',{})
                    if summary.get('status')=='ok':
                        for metric in ['stargazers_count','forks_count','subscribers_count','open_issues_count','size']:
                            store.observe(source,metric,summary['data'][metric],{'repository':name},at=report['observed_at'])
                    for category in ['issues','pull_requests','discussions']:
                        dataset=datasets.get(category,{})
                        if dataset.get('status')=='ok' and not dataset.get('truncated'):
                            rows=dataset.get('items',[])
                            if category=='issues':rows=[r for r in rows if r.get('kind')=='issue']
                            store.observe(source,category+'_total',len(rows),{'repository':name},at=report['observed_at'])
                            if category!='discussions':
                                for state in ['open','closed']:store.observe(source,category+'_'+state,sum(r.get('state')==state for r in rows),{'repository':name},at=report['observed_at'])
                    releases=datasets.get('releases',{})
                    if releases.get('status')=='ok':
                        for release in releases.get('items',[]):
                            for asset in release.get('assets',[]):store.observe(source,'asset_downloads',asset['download_count'],{'repository':name,'tag':release['tag_name'],'asset_id':asset['id'],'file':asset['name']},'cumulative',report['observed_at'])
                    for metric in ['views','clones']:
                        dataset=datasets.get('traffic_'+metric,{})
                        if dataset.get('status')=='ok':
                            for day in dataset['data'][metric]:
                                for field in ['count','uniques']:store.observe(source,metric+'_'+field,day[field],{'repository':name,'period':'day'},'period',day['timestamp'])
                store.snapshot(source,item,report['observed_at'])
            else:store.snapshot(source,item,data['observed_at'])
        store.run(source,apply)
    return True

def operations(store,root):
    store.observe('operations','load_average_1m',os.getloadavg()[0])
    disk=shutil.disk_usage(root)
    store.observe('operations','disk_free_bytes',disk.free);store.observe('operations','disk_total_bytes',disk.total)
    for name in ['qoopia-auth','qoopia-corsair']:
        command=['docker','inspect','--format','{{json .State}}',name]
        r=subprocess.run(command,text=True,capture_output=True,timeout=10)
        if r.returncode:raise RuntimeError('container state unavailable')
        data=json.loads(r.stdout)
        for metric,value in [('running',data['Running']),('restarting',data['Restarting']),('oom_killed',data['OOMKilled'])]:store.observe('operations','container_'+metric,int(value),{'container':name})
        health=data.get('Health',{}).get('Status')
        if health is not None:store.observe('operations','container_healthy',int(health=='healthy'),{'container':name})

def daily_backup(store,directory):
    root=Path(directory);root.mkdir(parents=True,exist_ok=True,mode=0o700)
    file=root/(datetime.datetime.now(UTC).date().isoformat()+'.sqlite')
    if file.exists():return
    temp=file.with_suffix('.tmp')
    with sqlite3.connect(temp) as target:
        store.db.backup(target)
        if target.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('analytics backup integrity failed')
    temp.replace(file)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--db',required=True);p.add_argument('--auth-db');p.add_argument('--memory-db');p.add_argument('--events-db');p.add_argument('--github',action='store_true');p.add_argument('--provider-import');p.add_argument('--export');p.add_argument('--owner-export');p.add_argument('--backup');p.add_argument('--backup-directory');p.add_argument('--operations',action='store_true');a=p.parse_args();os.umask(0o077)
    s=Store(a.db);ok=[]
    if a.github:ok.append(s.run('github_releases',lambda:github(s,'qoopia/qoopia-downloads')))
    if a.auth_db:ok.append(s.run('account_service',lambda:sql_source(s,a.auth_db,'account_service')))
    if a.memory_db:ok.append(s.run('owner_memory_only',lambda:sql_source(s,a.memory_db,'owner_memory_only')))
    if a.events_db:ok.append(s.run('first_party_events',lambda:import_events(s,a.events_db)))
    if a.provider_import:
        ok.append(provider_import(s,a.provider_import))
    if a.operations:ok.append(s.run('operations',lambda:operations(s,Path(a.db).parent)))
    if a.backup_directory:ok.append(s.run('analytics_backup',lambda:daily_backup(s,a.backup_directory)))
    if a.export:
        dest=Path(a.export);temp=dest.with_suffix('.tmp');temp.write_text(json.dumps(s.export(),ensure_ascii=False,indent=2)+'\n');temp.replace(dest)
    if a.owner_export:
        data=s.export();data={k:data[k] for k in ['generated_at','latest','event_daily','source_runs','github_ecosystem','github_history']}
        dest=Path(a.owner_export);temp=dest.with_suffix('.tmp');temp.write_text(json.dumps(data,ensure_ascii=False)+'\n')
        temp.replace(dest)
    if a.backup:
        with sqlite3.connect(a.backup) as target:s.db.backup(target)
    print(canonical({'status':'ok' if all(ok) else 'partial','checks':len(ok),'failures':ok.count(False),'db':str(Path(a.db).resolve())}));s.db.close()
    return 0 if all(ok) else 1
if __name__=='__main__':sys.exit(main())
