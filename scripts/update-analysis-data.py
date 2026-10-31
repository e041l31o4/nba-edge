import json, os, re, datetime, urllib.request, pathlib, subprocess, sys
BASE='https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
HEAD={'User-Agent':'Mozilla/5.0 NBA-EDGE/1.0'}
def get(url):
    req=urllib.request.Request(url,headers=HEAD)
    with urllib.request.urlopen(req,timeout=25) as r: return json.load(r)
def save(path,data):
    pathlib.Path(path).parent.mkdir(parents=True,exist_ok=True)
    pathlib.Path(path).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
# Team IDs and names from ESPN's current league list
league=get(BASE+'/teams?limit=40')
teams=league.get('sports',[{}])[0].get('leagues',[{}])[0].get('teams',[])
forms={}
season=datetime.datetime.now(datetime.timezone.utc).year
for item in teams:
    t=item.get('team',{})
    tid=str(t.get('id',''))
    if not tid: continue
    try:
        sched=get(f'{BASE}/teams/{tid}/schedule?season={season}')
        rows=[]
        for event in sched.get('events',[]):
            comp=(event.get('competitions') or [{}])[0]
            if not comp.get('status',{}).get('type',{}).get('completed'): continue
            competitors=comp.get('competitors',[])
            own=next((x for x in competitors if str(x.get('id'))==tid or str(x.get('team',{}).get('id'))==tid),None)
            opp=next((x for x in competitors if x is not own),None)
            if not own or not opp: continue
            try: pf=float(own.get('score')); pa=float(opp.get('score'))
            except (TypeError,ValueError): continue
            rows.append({'date':event.get('date'),'pointsFor':pf,'pointsAgainst':pa,'win':pf>pa,'opponent':opp.get('team',{}).get('displayName','')})
        rows.sort(key=lambda x:x.get('date') or '',reverse=True)
        forms[tid]={'teamId':tid,'team':t.get('displayName'),'abbreviation':t.get('abbreviation'),'last10':rows[:10]}
    except Exception as e:
        print('schedule skipped',tid,str(e)[:120])
save('public/data/team-form.json',{'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'ESPN public scoreboard/schedule data','teams':forms})
# NBA official injury report page; resolve its latest linked PDF and parse status rows.
injuries=[]
source='https://official.nba.com/nba-injury-report-2026-27-season/'
try:
    import html
    page=urllib.request.urlopen(urllib.request.Request(source,headers=HEAD),timeout=25).read().decode('utf-8','ignore')
    links=re.findall(r'https?://[^"\\\'<> ]+?\\.pdf|href=["\\\']([^"\\\']+\\.pdf)',page,re.I)
    urls=[]
    for x in links:
        u=x if isinstance(x,str) else ''
        if u and u.startswith('/'): u='https://official.nba.com'+u
        if u: urls.append(html.unescape(u))
    if not urls:
        # Many official report links are relative and embedded in href attributes.
        for u in re.findall(r'href=["\\\']([^"\\\']+)',page,re.I):
            if '.pdf' in u.lower():
                if u.startswith('/'): u='https://official.nba.com'+u
                elif u.startswith('//'): u='https:'+u
                elif not u.startswith('http'): u='https://official.nba.com/'+u.lstrip('/')
                urls.append(html.unescape(u))
    if urls:
        pdf=urllib.request.urlopen(urllib.request.Request(urls[0],headers=HEAD),timeout=30).read()
        pathlib.Path('/tmp/nba-injury.pdf').write_bytes(pdf)
        try:
            import pypdf
            text='\\n'.join(p.extract_text() or '' for p in pypdf.PdfReader('/tmp/nba-injury.pdf').pages)
            for line in text.splitlines():
                m=re.search(r'^\\s*([A-Z]{2,3})\\s+(.+?)\\s+(Out|Doubtful|Questionable|Probable|Available)\\b',line,re.I)
                if m: injuries.append({'team':m.group(1),'player':m.group(2).strip(),'status':m.group(3).title(),'sourceUrl':urls[0]})
        except Exception as e: print('PDF parse unavailable:',e)
except Exception as e: print('Official injury report unavailable:',e)
save('public/data/injuries.json',{'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'NBA Official Injury Report','sourceUrl':source,'players':injuries,'status':'available' if injuries else 'unavailable'})
print('Saved team form for',len(forms),'teams; official injury rows:',len(injuries))
