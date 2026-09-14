#!/usr/bin/env python3
"""Authenticated provider metadata bridge. Credentials stay on their owning host."""
import argparse,datetime,json,subprocess,urllib.request,urllib.parse,collections,os
from pathlib import Path
UTC=datetime.timezone.utc

def request(url,token,body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(url,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'Qoopia-Analytics/1'})
    with urllib.request.urlopen(req,timeout=25) as response:
        raw=response.read(8*1024*1024+1)
        if len(raw)>8*1024*1024:raise ValueError('response too large')
        return json.loads(raw)

def secret(file):
    p=Path(file);s=p.lstat()
    if p.is_symlink() or s.st_mode&0o077 or s.st_size>8192:raise ValueError('private credential file required')
    return p.read_text().strip()

def github(gh):
    rows=[]
    for endpoint in ['views','clones','popular/paths','popular/referrers']:
        r=subprocess.run([gh,'api','repos/qoopia/qoopia-downloads/traffic/'+endpoint],text=True,capture_output=True,timeout=35)
        if r.returncode:raise PermissionError('GitHub traffic unavailable')
        data=json.loads(r.stdout)
        if endpoint in ['views','clones']:
            for day in data[endpoint]:
                for field in ['count','uniques']:rows.append({'metric':endpoint+'_'+field,'value':day[field],'kind':'period','at':day['timestamp'],'dimensions':{'period':'day'}})
        else:
            for item in data:
                # Public repository paths only; omit titles and query/fragment.
                dim={'path':item['path'].split('?')[0].split('#')[0]} if endpoint.endswith('paths') else {'referrer':item['referrer'][:200]}
                for field in ['count','uniques']:rows.append({'metric':endpoint.replace('/','_')+'_'+field,'value':item[field],'kind':'gauge','dimensions':{**dim,'window':'provider_14d_top10'}})
    return rows

def cloudflare(config):
    conf=json.loads(Path(config).read_text());token=secret(conf['token_file']);start=(datetime.datetime.now(UTC)-datetime.timedelta(days=6)).date().isoformat()
    q='query { viewer { zones(filter: {zoneTag: "'+conf['zone']+'"}) { httpRequests1dGroups(limit: 7, filter: {date_geq: "'+start+'"}) { dimensions { date } sum { requests bytes cachedRequests cachedBytes threats pageViews } uniq { uniques } } } } }'
    data=request('https://api.cloudflare.com/client/v4/graphql',token,{'query':q})
    if data.get('errors'):raise PermissionError('Cloudflare zone analytics read unavailable')
    zones=data['data']['viewer']['zones']
    if len(zones)!=1:raise ValueError('zone coverage unavailable')
    rows=[]
    for day in zones[0]['httpRequests1dGroups']:
        for field,value in {**day['sum'],**day['uniq']}.items():rows.append({'metric':field,'value':value,'kind':'period','at':day['dimensions']['date']+'T00:00:00+00:00','dimensions':{'scope':'whole_qoopia_zone'}})
    return rows

def resend(file):
    token=secret(file);after='';counts=collections.Counter();seen=set()
    for _ in range(100):
        data=request('https://api.resend.com/emails?limit=100'+('&after='+urllib.parse.quote(after) if after else ''),token)
        for mail in data['data']:
            if mail['id'] in seen:raise ValueError('provider pagination repeated')
            seen.add(mail['id'])
            # Restrict the provider account to Qoopia mail. Never persist or emit
            # addresses, subjects, message bodies, attachments or tracking links.
            if 'mail.qoopia.ai' not in mail.get('from',''):continue
            day=mail['created_at'][:10];state=mail.get('last_event') or 'unknown'
            if state not in ['sent','delivered','delivery_delayed','complained','bounced','opened','clicked','failed','canceled','queued','scheduled']:state='other'
            counts[(day,state)]+=1
        if not data['has_more']:break
        if not data['data']:raise ValueError('empty pagination cursor')
        after=data['data'][-1]['id']
    else:raise ValueError('provider page limit reached')
    # This is the retained provider window, not total sent since product launch.
    return [{'metric':'retained_messages_by_latest_status','value':n,'kind':'gauge','dimensions':{'created_day':day,'last_event':state,'window':'provider_retained'}} for (day,state),n in counts.items()]

def main():
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--gh');p.add_argument('--cloudflare-config');p.add_argument('--resend-key-file');a=p.parse_args();os.umask(0o077)
    data={'format':'qoopia-provider-metrics/1','observed_at':datetime.datetime.now(UTC).isoformat(),'sources':{}}
    sources=[('github_traffic',lambda:github(a.gh),bool(a.gh)),('cloudflare',lambda:cloudflare(a.cloudflare_config),bool(a.cloudflare_config)),('resend',lambda:resend(a.resend_key_file),bool(a.resend_key_file))]
    for name,fn,configured in sources:
        if not configured:data['sources'][name]={'status':'missing_read_access','metrics':[]};continue
        try:data['sources'][name]={'status':'ok','metrics':fn()}
        except Exception as e:data['sources'][name]={'status':'unavailable','error_code':type(e).__name__,'metrics':[]}
    dest=Path(a.out);dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);temp=dest.with_suffix('.tmp');temp.write_text(json.dumps(data,indent=2)+'\n');temp.replace(dest)
    print(json.dumps({k:v['status'] for k,v in data['sources'].items()}))
if __name__=='__main__':main()
