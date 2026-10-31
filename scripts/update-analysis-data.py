import json, re, datetime, urllib.request, pathlib, html, sys

BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
HEAD = {'User-Agent': 'Mozilla/5.0 NBA-EDGE/1.1'}

def get(url):
    req = urllib.request.Request(url, headers=HEAD)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)

def save(path, data):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def extract_events(payload):
    if isinstance(payload, dict):
        if isinstance(payload.get('events'), list):
            return payload['events']
        for key in ('schedule', 'team', 'data'):
            value = payload.get(key)
            if isinstance(value, dict) and isinstance(value.get('events'), list):
                return value['events']
    return []

def completed_event(event):
    competition = (event.get('competitions') or [{}])[0]
    status = event.get('status') or competition.get('status') or {}
    typ = status.get('type') or {}
    state = str(typ.get('state') or '').lower()
    name = str(typ.get('name') or status.get('name') or '').lower()
    return typ.get('completed') is True or state in ('post', 'final') or 'final' in name

def score_value(value):
    if isinstance(value, dict):
        value = value.get('value', value.get('displayValue'))
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

def event_row(event, team_id):
    competitions = event.get('competitions') or []
    comp = competitions[0] if competitions else event
    competitors = comp.get('competitors') or []
    own = next((x for x in competitors if str((x.get('team') or {}).get('id') or x.get('id')) == str(team_id)), None)
    opponent = next((x for x in competitors if x is not own), None)
    if not own or not opponent:
        return None
    pf, pa = score_value(own.get('score')), score_value(opponent.get('score'))
    if pf is None or pa is None:
        return None
    return {
        'date': event.get('date') or comp.get('date'),
        'pointsFor': pf,
        'pointsAgainst': pa,
        'win': pf > pa,
        'opponent': (opponent.get('team') or {}).get('displayName', ''),
        'opponentId': str((opponent.get('team') or {}).get('id') or opponent.get('id') or '')
    }

now = datetime.datetime.now(datetime.timezone.utc)
season = now.year + 1 if now.month >= 7 else now.year
league = get(BASE + '/teams?limit=40')
teams = league.get('sports', [{}])[0].get('leagues', [{}])[0].get('teams', [])
forms = {}
roster_map = {}

for item in teams:
    team = item.get('team', {})
    team_id = str(team.get('id') or '')
    if not team_id:
        continue
    try:
        schedule = get(f'{BASE}/teams/{team_id}/schedule?season={season}')
        events = extract_events(schedule)
        # ESPN sometimes omits the completion boolean while retaining state=post.
        if not events:
            schedule = get(f'{BASE}/teams/{team_id}/schedule')
            events = extract_events(schedule)
        rows = []
        for event in events:
            if not completed_event(event):
                continue
            event_season = event.get('season') or {}
            competition_season = ((event.get('competitions') or [{}])[0].get('season') or {})
            season_type = event_season.get('type') or competition_season.get('type')
            if season_type is not None and str(season_type) != '2':
                continue
            row = event_row(event, team_id)
            if row:
                rows.append(row)
        rows.sort(key=lambda row: row.get('date') or '', reverse=True)
        forms[team_id] = {
            'teamId': team_id,
            'team': team.get('displayName'),
            'abbreviation': team.get('abbreviation'),
            'last10': rows[:10]
        }
        try:
            roster = get(f'{BASE}/teams/{team_id}/roster')
            def walk_roster(node):
                if isinstance(node, list):
                    for value in node:
                        walk_roster(value)
                elif isinstance(node, dict):
                    name = node.get('displayName') or node.get('fullName') or node.get('name')
                    athlete_id = node.get('id')
                    if isinstance(name, str) and athlete_id:
                        position = node.get('position') or {}
                        roster_map[name.strip().lower()] = {
                            'team': team.get('abbreviation', ''),
                            'athleteId': str(athlete_id),
                            'position': position.get('abbreviation', '') if isinstance(position, dict) else str(position or '')
                        }
                    for key, value in node.items():
                        if key not in ('statistics', 'stats'):
                            walk_roster(value)
            walk_roster(roster)
        except Exception as error:
            print('roster skipped', team_id, str(error)[:100])
    except Exception as error:
        print('schedule skipped', team_id, str(error)[:120])

# If the per-team schedule endpoint shape changes, use one league-wide date-range scoreboard.
games_found = sum(len(x['last10']) for x in forms.values())
if games_found == 0:
    start = (now - datetime.timedelta(days=45)).strftime('%Y%m%d')
    end = now.strftime('%Y%m%d')
    try:
        board = get(f'{BASE}/scoreboard?dates={start}-{end}&limit=1000')
        for event in board.get('events', []):
            if not completed_event(event):
                continue
            event_season = event.get('season') or {}
            if event_season.get('type') is not None and str(event_season.get('type')) != '2':
                continue
            comp = (event.get('competitions') or [{}])[0]
            for competitor in comp.get('competitors', []):
                team_id = str(competitor.get('id') or (competitor.get('team') or {}).get('id') or '')
                if team_id not in forms:
                    continue
                row = event_row(event, team_id)
                if row:
                    forms[team_id]['last10'].append(row)
        for value in forms.values():
            value['last10'].sort(key=lambda row: row.get('date') or '', reverse=True)
            value['last10'] = value['last10'][:10]
        games_found = sum(len(x['last10']) for x in forms.values())
    except Exception as error:
        print('league scoreboard fallback unavailable:', str(error)[:160])

if not forms or games_found == 0:
    raise SystemExit('No completed NBA team results parsed; refusing to overwrite valid team-form data with empty arrays.')

save('public/data/team-form.json', {
    'updatedAt': now.isoformat(),
    'source': 'ESPN public team schedules / scoreboard',
    'teams': forms
})

injuries = []
injury_source = 'NBA Official Injury Report'
injury_url = 'https://official.nba.com/nba-injury-report-2026-27-season/'
try:
    page = urllib.request.urlopen(urllib.request.Request(injury_url, headers=HEAD), timeout=25).read().decode('utf-8', 'ignore')
    links = re.findall(r'href="([^"]+\.pdf)', page, re.I) + re.findall(r"href='([^']+\.pdf)", page, re.I)
    urls = []
    for link in links:
        if link.startswith('/'):
            link = 'https://official.nba.com' + link
        elif link.startswith('//'):
            link = 'https:' + link
        elif not link.startswith('http'):
            link = 'https://official.nba.com/' + link.lstrip('/')
        urls.append(html.unescape(link))
    urls = [url for url in urls if 'injury' in url.lower() and 'report' in url.lower()]
    if urls:
        injury_url = urls[0]
        pdf = urllib.request.urlopen(urllib.request.Request(injury_url, headers=HEAD), timeout=30).read()
        pathlib.Path('/tmp/nba-injury.pdf').write_bytes(pdf)
        import pypdf
        pdf_text = '\n'.join(page.extract_text() or '' for page in pypdf.PdfReader('/tmp/nba-injury.pdf').pages)
        for line in pdf_text.splitlines():
            match = re.search(r'^\s*([A-Z]{2,3})\s+(.+?)\s+(Out|Doubtful|Questionable|Probable|Available)\b\s*(.*)$', line, re.I)
            if match:
                player_name = match.group(2).strip()
                roster_info = roster_map.get(player_name.lower(), {})
                injuries.append({
                    'team': match.group(1), 'player': player_name,
                    'status': match.group(3).title(), 'detail': match.group(4).strip(),
                    'athleteId': roster_info.get('athleteId'), 'position': roster_info.get('position'),
                    'sourceUrl': injury_url
                })
except Exception as error:
    print('Official injury report unavailable:', str(error)[:160])

if not injuries:
    try:
        injury_url = BASE + '/injuries'
        payload = get(injury_url)
        def walk_injuries(node, team_hint=''):
            if isinstance(node, list):
                for value in node:
                    walk_injuries(value, team_hint)
            elif isinstance(node, dict):
                team_obj = node.get('team') or {}
                if not isinstance(team_obj, dict):
                    team_obj = {}
                team = team_obj.get('abbreviation') or team_obj.get('shortDisplayName') or team_obj.get('displayName') or team_hint
                athlete = node.get('athlete') or node.get('player') or {}
                if isinstance(athlete, dict):
                    name = athlete.get('displayName') or athlete.get('fullName') or athlete.get('name')
                    records = node.get('injuries') or [node]
                    if isinstance(records, dict):
                        records = [records]
                    if isinstance(name, str) and isinstance(records, list):
                        for record in records:
                            if not isinstance(record, dict):
                                continue
                            raw_status = record.get('status')
                            if isinstance(raw_status, dict):
                                raw_status = raw_status.get('description') or raw_status.get('name')
                            raw_type = record.get('type')
                            status = raw_status or record.get('description') or (raw_type.get('description') if isinstance(raw_type, dict) else raw_type)
                            raw_detail = record.get('details') or record.get('longComment') or record.get('comment') or ''
                            if isinstance(raw_detail, dict):
                                detail = ' · '.join(str(raw_detail.get(k)) for k in ('type', 'location', 'detail', 'side', 'returnDate') if raw_detail.get(k))
                            else:
                                detail = str(raw_detail)
                            roster_info = roster_map.get(name.strip().lower(), {})
                            team = team or roster_info.get('team', '')
                            if status:
                                row = {
                                    'team': str(team or '球隊待確認'),
                                    'player': name,
                                    'status': str(status),
                                    'detail': detail,
                                    'athleteId': roster_info.get('athleteId'),
                                    'position': roster_info.get('position'),
                                    'sourceUrl': injury_url
                                }
                                if not any(existing['team'] == row['team'] and existing['player'] == row['player'] for existing in injuries):
                                    injuries.append(row)
                for key, value in node.items():
                    if key not in ('athlete', 'player', 'team'):
                        walk_injuries(value, str(team or team_hint))
        walk_injuries(payload)
        if injuries:
            injury_source = 'ESPN public injury feed (fallback)'
    except Exception as error:
        print('ESPN injury fallback unavailable:', str(error)[:160])

# Enrich listed players with season PPG / MPG so the match model can estimate role-weighted absence cost.
def numeric_stat(value):
    try:
        return float(str(value).replace(',', '').strip())
    except (TypeError, ValueError):
        return None

for player in injuries:
    athlete_id = player.get('athleteId')
    if not athlete_id:
        continue
    try:
        overview = get(f'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{athlete_id}/overview')
        stats = overview.get('statistics') or overview.get('stats') or {}
        labels = stats.get('labels') or stats.get('names') or []
        values = stats.get('displayValues') or stats.get('values') or []
        def find_stat(names):
            for index, label in enumerate(labels):
                if str(label).strip().lower() in names and index < len(values):
                    return numeric_stat(values[index])
            return None
        player['pointsPerGame'] = find_stat({'pts', 'avgpoints', 'points'})
        player['minutesPerGame'] = find_stat({'min', 'avgminutes', 'minutes'})
    except Exception as error:
        print('player stats skipped', player.get('player'), str(error)[:100])

save('public/data/injuries.json', {
    'updatedAt': now.isoformat(),
    'source': injury_source,
    'sourceUrl': injury_url,
    'players': injuries,
    'status': 'available' if injuries else 'unavailable'
})
print('Saved team form for', len(forms), 'teams;', games_found, 'completed team results; injury rows:', len(injuries), 'source:', injury_source)
