import json, re, datetime, urllib.request, pathlib
BASE='https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
HEAD={'User-Agent':'Mozilla/5.0 NBA-EDGE/1.0'}

def get(url):
    req=urllib.request.Request(url,headers=HEAD)
    with urllib.request.urlopen(req,timeout=25) as response:
        return json.load(response)

def save(path,data):
    pathlib.Path(path).parent.mkdir(parents=True,exist_ok=True)
    pathlib.Path(path).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')

league=get(BASE+'/teams?limit=40')
teams=league.get('sports',[{}])[0].get('leagues',[{}])[0].get('teams',[])
forms={}
season=datetime.datetime.now(datetime.timezone.utc).year
for item in teams:
    team=item.get('team',{})
    team_id=str(team.get('id',''))
    if not team_id:
        continue
    try:
        schedule=get(f'{BASE}/teams/{team_id}/schedule?season={season}')
        rows=[]
        for event in schedule.get('events',[]):
            comp=(event.get('competitions') or [{}])[0]
            if not comp.get('status',{}).get('type',{}).get('completed'):
                continue
            competitors=comp.get('competitors',[])
            own=next((x for x in competitors if str(x.get('id'))==team_id or str(x.get('team',{}).get('id'))==team_id),None)
            opponent=next((x for x in competitors if x is not own),None)
            if not own or not opponent:
                continue
            try:
                points_for=float(own.get('score'))
                points_against=float(opponent.get('score'))
            except (TypeError,ValueError):
                continue
            rows.append({'date':event.get('date'),'pointsFor':points_for,'pointsAgainst':points_against,'win':points_for>points_against,'opponent':opponent.get('team',{}).get('displayName','')})
        rows.sort(key=lambda row:row.get('date') or '',reverse=True)
        forms[team_id]={'teamId':team_id,'team':team.get('displayName'),'abbreviation':team.get('abbreviation'),'last10':rows[:10]}
    except Exception as error:
        print('schedule skipped',team_id,str(error)[:120])
save('public/data/team-form.json',{'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'ESPN public scoreboard/schedule data','teams':forms})

injuries=[]
injury_source='NBA Official Injury Report'
injury_url='https://official.nba.com/nba-injury-report-2026-27-season/'
try:
    import html
    page=urllib.request.urlopen(urllib.request.Request(injury_url,headers=HEAD),timeout=25).read().decode('utf-8','ignore')
    links=re.findall(r'href="([^"]+\.pdf)',page,re.I) + re.findall(r"href='([^']+\.pdf)",page,re.I)
    urls=[]
    for link in links:
        if link.startswith('/'):
            link='https://official.nba.com'+link
        elif link.startswith('//'):
            link='https:'+link
        elif not link.startswith('http'):
            link='https://official.nba.com/'+link.lstrip('/')
        urls.append(html.unescape(link))
    if urls:
        injury_url=urls[0]
        pdf=urllib.request.urlopen(urllib.request.Request(injury_url,headers=HEAD),timeout=30).read()
        pathlib.Path('/tmp/nba-injury.pdf').write_bytes(pdf)
        import pypdf
        pdf_text='\n'.join(page.extract_text() or '' for page in pypdf.PdfReader('/tmp/nba-injury.pdf').pages)
        for line in pdf_text.splitlines():
            match=re.search(r'^\s*([A-Z]{2,3})\s+(.+?)\s+(Out|Doubtful|Questionable|Probable|Available)\b\s*(.*)$',line,re.I)
            if match:
                injuries.append({'team':match.group(1),'player':match.group(2).strip(),'status':match.group(3).title(),'detail':match.group(4).strip(),'sourceUrl':injury_url})
except Exception as error:
    print('Official injury report unavailable:',str(error)[:160])

if not injuries:
    try:
        injury_url=BASE+'/injuries'
        payload=get(injury_url)
        def walk_injuries(node,team_hint=''):
            if isinstance(node,list):
                for value in node:
                    walk_injuries(value,team_hint)
            elif isinstance(node,dict):
                team_obj=node.get('team') or {}
                if not isinstance(team_obj,dict):
                    team_obj={}
                team=team_obj.get('abbreviation') or team_obj.get('shortDisplayName') or team_obj.get('displayName') or team_hint
                athlete=node.get('athlete') or node.get('player') or {}
                if isinstance(athlete,dict):
                    name=athlete.get('displayName') or athlete.get('fullName') or athlete.get('name')
                    records=node.get('injuries') or [node]
                    if isinstance(records,dict):
                        records=[records]
                    if isinstance(name,str) and isinstance(records,list):
                        for record in records:
                            if not isinstance(record,dict):
                                continue
                            raw_status=record.get('status')
                            if isinstance(raw_status,dict):
                                raw_status=raw_status.get('description') or raw_status.get('name')
                            raw_type=record.get('type')
                            status=raw_status or record.get('description') or (raw_type.get('description') if isinstance(raw_type,dict) else raw_type)
                            detail=record.get('details') or record.get('longComment') or record.get('comment') or ''
                            if status:
                                row={'team':str(team or '球隊待確認'),'player':name,'status':str(status),'detail':str(detail),'sourceUrl':injury_url}
                                if not any(existing['team']==row['team'] and existing['player']==row['player'] for existing in injuries):
                                    injuries.append(row)
                for key,value in node.items():
                    if key not in ('athlete','player','team'):
                        walk_injuries(value,str(team or team_hint))
        walk_injuries(payload)
        if injuries:
            injury_source='ESPN public injury feed (fallback)'
    except Exception as error:
        print('ESPN injury fallback unavailable:',str(error)[:160])

save('public/data/injuries.json',{'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':injury_source,'sourceUrl':injury_url,'players':injuries,'status':'available' if injuries else 'unavailable'})
print('Saved team form for',len(forms),'teams; injury rows:',len(injuries),'source:',injury_source)
