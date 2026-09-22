#!/usr/bin/env python3
"""Bounded public observation; no credentials, redirects, mutations or rankings."""
import re
import argparse, datetime as dt, fcntl, hashlib, html.parser, json, os, subprocess, tempfile, time
import urllib.parse, urllib.robotparser, xml.etree.ElementTree as ET
from pathlib import Path

URLS = {
    'home':'https://qoopia.ai/', 'docs':'https://qoopia.ai/docs',
    'releases':'https://qoopia.ai/releases', 'understand':'https://qoopia.ai/understand',
    'understand-ru':'https://qoopia.ai/understand-ru', 'mobile':'https://qoopia.ai/mobile',
    'robots':'https://qoopia.ai/robots.txt','sitemap':'https://qoopia.ai/sitemap.xml',
    'release':'https://qoopia.ai/release.json',
    'source-readme':'https://raw.githubusercontent.com/qoopia/qoopia-source/main/README.md',
    'source-manifest':'https://raw.githubusercontent.com/qoopia/qoopia-source/main/SOURCE-MANIFEST.json',
    'source-facts':'https://raw.githubusercontent.com/qoopia/qoopia-source/main/docs/discovery/answers.json',
}
UA='QoopiaDiscovery/1.0 (+https://qoopia.ai)'
MAX_BYTES=2_000_000
class Page(html.parser.HTMLParser):
    def __init__(self):
        super().__init__();self.title=[];self.h1=0;self.meta={};self.canon=[];self.links=[];self.in_title=False
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='title':self.in_title=True
        if tag=='h1':self.h1+=1
        if tag=='meta':self.meta[a.get('name',a.get('property',''))]=a.get('content','')
        if tag=='link' and a.get('rel')=='canonical':self.canon.append(a.get('href'))
        if tag=='a':self.links.append(a.get('href',''))
    def handle_endtag(self,tag):
        if tag=='title':self.in_title=False
    def handle_data(self,text):
        if self.in_title:self.title.append(text)

def fetch(url, out, curl='curl'):
    if url not in URLS.values():raise ValueError('URL outside fixed public allowlist')
    with tempfile.TemporaryDirectory() as tmp:
        headers=Path(tmp)/'headers';body=Path(tmp)/'body'
        args=[curl,'--silent','--show-error','--proto','=https','--max-redirs','0','--connect-timeout','10','--max-time','25','--max-filesize',str(MAX_BYTES),'--user-agent',UA,'--dump-header',str(headers),'--output',str(body),'--write-out','%{http_code}',url]
        r=subprocess.run(args,capture_output=True,text=True,timeout=30)
        raw=body.read_bytes() if body.exists() else b''
        # Response headers are allowlisted: no cookies, authorization or request IDs.
        safe={}
        for line in headers.read_text(errors='replace').splitlines() if headers.exists() else []:
            k,sep,v=line.partition(':')
            if sep and k.lower() in ('content-type','cache-control','x-robots-tag','etag','last-modified'):safe[k.lower()]=v.strip()
        record={'url':url,'http_status':int(r.stdout) if r.stdout.isdigit() else None,'exit_code':r.returncode,'headers':safe,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        if r.returncode==0 and record['http_status']==200 and len(raw)<=MAX_BYTES:
            out.write_bytes(raw)
            return record,raw.decode('utf-8',errors='replace')
        record['result']='INSUFFICIENT DATA';return record,None

def inspect(key,text,record):
    findings=[]
    def issue(code,detail):findings.append({'surface':key,'code':code,'detail':detail})
    if text is None:
        issue('FETCH_UNAVAILABLE',str(record.get('http_status')));return findings
    if key in ('home','docs','releases','understand','understand-ru','mobile'):
        p=Page();p.feed(text)
        if not ''.join(p.title).strip():issue('TITLE_MISSING','No raw HTML title')
        if not p.meta.get('description'):issue('DESCRIPTION_MISSING','No raw HTML description')
        if p.h1!=1:issue('H1_COUNT',str(p.h1))
        if p.canon!=[URLS[key]]:issue('CANONICAL_MISMATCH',str(p.canon))
        if 'noindex' in (p.meta.get('robots','')+' '+record.get('headers',{}).get('x-robots-tag','')).lower():issue('NOINDEX','Intended public page excluded')
        if 'product source repository remains private' in text:issue('FALSE_PRIVATE_SOURCE','Public source contradicted by copy')
        if key=='home' and '/understand' not in text:issue('EVALUATION_NOT_LINKED','No direct explanation entry point')
    if key=='sitemap':
        try:
            locs=[n.text for n in ET.fromstring(text).iter() if n.tag.endswith('}loc')]
            expected={URLS[k] for k in ('home','docs','releases','understand','understand-ru','mobile')}
            if set(locs)!=expected:issue('SITEMAP_ROUTES','Expected public route set differs')
        except ET.ParseError:issue('SITEMAP_INVALID','XML parse error')
    if key=='robots':
        robot=urllib.robotparser.RobotFileParser();robot.parse(text.splitlines())
        for agent in ('Googlebot','OAI-SearchBot','Claude-SearchBot'):
            if not robot.can_fetch(agent,URLS['home']):issue('ROBOTS_BLOCK',agent)
    if key in ('release','source-manifest','source-facts'):
        try:
            value=json.loads(text)
            if key=='source-facts' and dt.date.fromisoformat(value['review_again_by'])<dt.date.today():issue('CLAIMS_REVIEW_DUE','Review expiry passed; do not auto-refresh date')
        except (ValueError,KeyError,TypeError):issue('JSON_INVALID','Missing or invalid contract')
    return findings

def run(output,curl='curl'):
    output.mkdir(parents=True,exist_ok=True)
    with (output/'.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'status':'ALREADY_RUNNING'}
        now=dt.datetime.now(dt.timezone.utc);folder=output/now.strftime('%Y%m%dT%H%M%S.%fZ');folder.mkdir()
        report={'version':1,'observed_at':now.isoformat(),'scope':'public HTTP, fixed allowlist, GET only, redirects not followed','results':{},'findings':[],'unavailable':['Search Console property metrics','Bing Webmaster property metrics','field Core Web Vitals','consumer ChatGPT/Claude answer visibility'],'rankings_measured':False}
        report['tool']=subprocess.run([curl,'--version'],capture_output=True,text=True,timeout=5).stdout.splitlines()[0]
        texts={}
        for key,url in URLS.items():
            try:record,text=fetch(url,folder/(key+'.body'),curl)
            except (OSError,subprocess.TimeoutExpired) as e:record,text={'url':url,'result':'INSUFFICIENT DATA','error_class':type(e).__name__},None
            report['results'][key]=record;report['findings']+=inspect(key,text,record)
            texts[key]=text
            time.sleep(.25)
        if texts.get('source-facts'):
            try:
                facts=json.loads(texts['source-facts'])
                for lang,key in [('en','understand'),('ru','understand-ru')]:
                    if texts.get(key):
                        for item in facts['items']:
                            if html.unescape(item[lang]['answer']) not in html.unescape(texts[key]):
                                report['findings'].append({'surface':key,'code':'FACT_PARITY','detail':item['id']})
            except (KeyError,TypeError,ValueError):
                report['findings'].append({'surface':'source-facts','code':'FACT_CONTRACT_INVALID','detail':'Cannot compare facts'})
        prior=json.loads((output/'latest.json').read_text()) if (output/'latest.json').exists() else {}
        signature=lambda r: sorted((x['surface'],x['code'],x['detail']) for x in r.get('findings',[]))
        report['changed_findings']=signature(report)!=signature(prior)
        report['status']='FINDINGS' if report['findings'] else 'TECHNICAL_CHECKS_PASS'
        body=json.dumps(report,ensure_ascii=False,indent=2)+'\n';(folder/'report.json').write_text(body)
        (folder/'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name+'\n' for f in sorted(folder.iterdir()) if f.is_file()))
        tmp=output/'latest.tmp';tmp.write_text(body);tmp.replace(output/'latest.json')
        # Bound retained observation files; aggregate metrics are kept separately.
        for old in output.iterdir():
            if old.is_dir() and re.fullmatch(r'\d{8}T\d{6}\.\d{6}Z',old.name) and (time.time()-old.stat().st_mtime)>90*86400:
                import shutil
                shutil.rmtree(old)
        return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--curl',default='curl');a=p.parse_args()
    r=run(a.output,a.curl);print(json.dumps({k:r[k] for k in ('status','observed_at','changed_findings','findings') if k in r},ensure_ascii=False))
    raise SystemExit(2 if r.get('findings') else 0)
