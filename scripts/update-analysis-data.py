import json, re, datetime, urllib.request, pathlib, html, sys, time, unicodedata

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
        'opponentId': str((opponent.get('team') or {}).get('id') or opponent.get('id') or ''),
        'homeAway': str(own.get('homeAway') or '').lower()
    }

now = datetime.datetime.now(datetime.timezone.utc)
season = now.year + 1 if now.month >= 7 else now.year
league = get(BASE + '/teams?limit=40')
teams = league.get('sports', [{}])[0].get('leagues', [{}])[0].get('teams', [])
forms = {}
roster_map = {}
rosters_by_team = {}

def normalize_player_name(value):
    value = unicodedata.normalize('NFKD', str(value or ''))
    value = ''.join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r'[^a-z0-9]', '', value.lower())


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
            team_roster = []
            seen_roster_ids = set()
            def walk_roster(node):
                if isinstance(node, list):
                    for value in node:
                        walk_roster(value)
                elif isinstance(node, dict):
                    name = node.get('displayName') or node.get('fullName') or node.get('name')
                    athlete_id = node.get('id')
                    if isinstance(name, str) and athlete_id:
                        position = node.get('position') or {}
                        position_abbr = position.get('abbreviation', '') if isinstance(position, dict) else str(position or '')
                        # ESPN roster payloads contain nested taxonomy nodes (e.g. school and position labels).
                        # Keep only actual player records with a recognized basketball position.
                        if position_abbr.upper() in ('PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'):
                            roster_entry = {
                                'team': team.get('abbreviation', ''),
                                'player': name.strip(),
                                'athleteId': str(athlete_id),
                                'position': position_abbr.upper(),
                                'jersey': node.get('jersey')
                            }
                            roster_map[name.strip().lower()] = roster_entry
                            roster_map[f"{team.get('abbreviation', '').upper()}|{normalize_player_name(name)}"] = roster_entry
                            if str(athlete_id) not in seen_roster_ids:
                                team_roster.append(roster_entry)
                                seen_roster_ids.add(str(athlete_id))
                    for key, value in node.items():
                        if key not in ('statistics', 'stats'):
                            walk_roster(value)
            walk_roster(roster)
            if team_roster:
                rosters_by_team[team.get('abbreviation', '')] = team_roster
        except Exception as error:
            print('roster skipped', team_id, str(error)[:100])
    except Exception as error:
        print('schedule skipped', team_id, str(error)[:120])


# Current-season team efficiency metrics from ESPN's public Core API.
# Display as context only until historical backtesting validates use in prediction.
def expand_espn_refs(node, depth=0, budget=None):
    # ESPN Core API frequently returns reference-only objects (notably splits).
    # Resolve a small, bounded number of references instead of treating the
    # wrapper response as if it already contained the statistics.
    if budget is None:
        budget = {'remaining': 12, 'seen': set()}
    if depth > 4:
        return node
    if isinstance(node, list):
        return [expand_espn_refs(value, depth + 1, budget) for value in node]
    if not isinstance(node, dict):
        return node
    ref = node.get('$ref')
    if isinstance(ref, str) and ref.startswith('https://') and budget['remaining'] > 0 and ref not in budget['seen']:
        budget['remaining'] -= 1
        budget['seen'].add(ref)
        try:
            resolved = get(ref)
            if isinstance(resolved, dict):
                merged = dict(node)
                merged.update(resolved)
                node = merged
        except Exception as error:
            print('ESPN reference resolution skipped:', str(error)[:120])
    return {key: expand_espn_refs(value, depth + 1, budget) if isinstance(value, (dict, list)) else value
            for key, value in node.items()}

def extract_team_metrics(payload):
    found = {}
    aliases = {
        'offensiveRating': {'offensiverating', 'offensiveefficiency', 'offensiveefficiencyrating', 'offrtg'},
        'defensiveRating': {'defensiverating', 'defensiveefficiency', 'defensiveefficiencyrating', 'defrtg'},
        'netRating': {'netrating', 'netefficiency', 'netrtg'},
        'pace': {'pace', 'pacefactor'},
        'trueShootingPct': {'trueshootingpct', 'trueshootingpercentage', 'tspct'},
        'turnoverPct': {'turnoverpct', 'turnoverpercentage', 'tovpct'},
        'reboundPct': {'reboundpct', 'reboundpercentage', 'rebpct'},
        'gamesPlayed': {'gamesplayed', 'games', 'gp'}
    }
    def visit(node):
        if isinstance(node, list):
            for value in node: visit(value)
        elif isinstance(node, dict):
            label = next((node.get(k) for k in ('name', 'abbreviation', 'displayName', 'shortDisplayName') if node.get(k)), None)
            if label is not None:
                normalized = re.sub(r'[^a-z0-9]', '', str(label).lower())
                for target, accepted in aliases.items():
                    if normalized in accepted and target not in found:
                        raw_value = node.get('value', node.get('displayValue'))
                        try: parsed = float(str(raw_value).replace(',', '').replace('%', '').strip())
                        except (TypeError, ValueError): parsed = None
                        if parsed is not None: found[target] = parsed
            for value in node.values():
                if isinstance(value, (dict, list)): visit(value)
    visit(payload)
    return found

team_metrics = {}
previous_metrics = {}
try:
    previous_metrics = json.loads(pathlib.Path('public/data/team-metrics.json').read_text(encoding='utf-8')).get('teams', {})
except Exception:
    pass

for item in teams:
    team = item.get('team', {})
    team_id = str(team.get('id') or '')
    abbreviation = str(team.get('abbreviation') or '')
    if not team_id or not abbreviation: continue
    try:
        stats_url = f'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/{season}/types/2/teams/{team_id}/statistics?lang=en&region=us'
        payload = get(stats_url)
        expanded_payload = expand_espn_refs(payload)
        metrics = extract_team_metrics(expanded_payload)
        if abbreviation == str((teams[0].get('team') or {}).get('abbreviation') or ''):
            categories = ((expanded_payload.get('splits') or {}).get('categories') or expanded_payload.get('categories', [])) if isinstance(expanded_payload, dict) else []
            category_names = [str(x.get('name') or x.get('displayName') or '') for x in categories if isinstance(x, dict)]
            category_stats = []
            for category in categories[:5]:
                if isinstance(category, dict):
                    for stat in (category.get('stats') or [])[:8]:
                        if isinstance(stat, dict):
                            category_stats.append({'name': stat.get('name'), 'abbreviation': stat.get('abbreviation'), 'displayName': stat.get('displayName'), 'value': stat.get('value'), 'displayValue': stat.get('displayValue')})
            print('TEAM_METRICS_RAW_DIAGNOSTIC', json.dumps({'topKeys': list(expanded_payload.keys())[:20] if isinstance(expanded_payload, dict) else str(type(expanded_payload)), 'categoryNames': category_names, 'allStatNames': [stat.get('name') for category in categories if isinstance(category, dict) for stat in (category.get('stats') or []) if isinstance(stat, dict)], 'sampleStats': category_stats[:20]}, ensure_ascii=False)[:7000])
        if len(metrics) >= 2:
            metrics.update({'teamId': team_id, 'abbreviation': abbreviation, 'updatedAt': now.isoformat(), 'stale': False})
            team_metrics[abbreviation] = metrics
        elif abbreviation in previous_metrics:
            old = dict(previous_metrics[abbreviation]); old['stale'] = True; team_metrics[abbreviation] = old
            print('team metrics insufficient; prior snapshot marked stale', abbreviation)
    except Exception as error:
        if abbreviation in previous_metrics:
            old = dict(previous_metrics[abbreviation]); old['stale'] = True; team_metrics[abbreviation] = old
        print('team metrics skipped', abbreviation, str(error)[:120])
    time.sleep(0.15)

if team_metrics:
    save('public/data/team-metrics.json', {
        'updatedAt': now.isoformat(), 'season': str(season),
        'source': 'ESPN public Core API team season statistics',
        'status': 'available' if any(not row.get('stale') for row in team_metrics.values()) else 'stale',
        'teams': team_metrics
    })
else:
    print('No verified current-season team efficiency metrics; preserving prior dataset.')

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
                roster_info = (
                    roster_map.get(f"{match.group(1).upper()}|{normalize_player_name(player_name)}")
                    or roster_map.get(player_name.lower(), {})
                )
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

# Enrich listed players with per-game box-score rates and usage where the public source provides them. The model only uses PPG/MPG for its current conservative absence estimate; other rates are shown as context until independently validated.
def numeric_stat(value):
    try:
        return float(str(value).replace(',', '').replace('%', '').strip())
    except (TypeError, ValueError):
        return None

def extract_player_averages(payload):
    found = {
        'pointsPerGame': None, 'minutesPerGame': None,
        'reboundsPerGame': None, 'assistsPerGame': None,
        'stealsPerGame': None, 'blocksPerGame': None,
        'turnoversPerGame': None, 'usageRate': None,
        'gamesPlayed': None
    }
    keys = {
        'pointsPerGame': {'pts', 'avgpoints', 'points', 'pointspergame'},
        'minutesPerGame': {'min', 'avgminutes', 'minutes', 'minutespergame'},
        'reboundsPerGame': {'reb', 'trb', 'avgrebounds', 'rebounds', 'reboundspergame'},
        'assistsPerGame': {'ast', 'avgassists', 'assists', 'assistspergame'},
        'stealsPerGame': {'stl', 'avgsteals', 'steals', 'stealspergame'},
        'blocksPerGame': {'blk', 'avgblocks', 'blocks', 'blockspergame'},
        'turnoversPerGame': {'to', 'tov', 'avgturnovers', 'turnovers', 'turnoverspergame'},
        'usageRate': {'usg%', 'usg', 'usage', 'usagerate', 'usage%'},
        'gamesPlayed': {'gp', 'games', 'gamesplayed'}
    }
    def visit(node):
        if isinstance(node, list):
            for value in node:
                visit(value)
        elif isinstance(node, dict):
            labels = node.get('labels') or node.get('names') or []
            values = node.get('displayValues') or node.get('values') or node.get('totals') or []
            if isinstance(labels, list) and isinstance(values, list):
                for index, label in enumerate(labels):
                    if index < len(values):
                        normalized = re.sub(r'[^a-z0-9%]', '', str(label).strip().lower())
                        for target, accepted in keys.items():
                            if normalized in accepted and found[target] is None:
                                found[target] = numeric_stat(values[index])
            label = next((node.get(k) for k in ('name', 'abbreviation', 'displayName', 'shortDisplayName') if node.get(k)), None)
            if label is not None:
                normalized = re.sub(r'[^a-z0-9%]', '', str(label).strip().lower())
                for target, accepted in keys.items():
                    if normalized in accepted and found[target] is None:
                        for value_key in ('value', 'displayValue', 'displayvalue'):
                            if node.get(value_key) is not None:
                                found[target] = numeric_stat(node.get(value_key))
                                break
            for value in node.values():
                if isinstance(value, (dict, list)):
                    visit(value)
    visit(payload)
    return found

# Keep previously verified player averages when ESPN's athlete overview/stats endpoint is unavailable.
previous_players = {}
try:
    previous_data = json.loads(pathlib.Path('public/data/injuries.json').read_text(encoding='utf-8'))
    for previous in previous_data.get('players', []):
        key = previous.get('athleteId') or (str(previous.get('team', '')).upper() + '|' + str(previous.get('player', '')).strip().lower())
        if key:
            previous_players[key] = previous
except Exception as error:
    print('Previous injury metrics unavailable:', str(error)[:120])

for player in injuries:
    key = player.get('athleteId') or (str(player.get('team', '')).upper() + '|' + str(player.get('player', '')).strip().lower())
    previous = previous_players.get(key, {})
    for field in ('pointsPerGame', 'minutesPerGame', 'reboundsPerGame', 'assistsPerGame', 'stealsPerGame', 'blocksPerGame', 'turnoversPerGame', 'usageRate', 'gamesPlayed'):
        if player.get(field) is None and previous.get(field) is not None:
            player[field] = previous[field]
    athlete_id = player.get('athleteId')
    if not athlete_id:
        continue
    averages = extract_player_averages({})
    overview_error = None
    try:
        overview = get(f'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{athlete_id}/overview')
        averages = extract_player_averages(overview)
    except Exception as error:
        overview_error = str(error)[:100]

    # Correct ESPN Web API v3 season-stat endpoint. The old site-v2
    # /athletes/{id}/stats route returned 404 for every injury row.
    if any(value is None for value in averages.values()):
        try:
            stats_url = (
                f'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/'
                f'athletes/{athlete_id}/stats?season={season}&seasontype=2'
            )
            stats_payload = get(stats_url)
            fallback = extract_player_averages(stats_payload)
            averages = {key: averages[key] if averages[key] is not None else fallback[key] for key in averages}
        except Exception as error:
            if overview_error:
                print('player stats unavailable', player.get('player'), 'overview:', overview_error, 'season stats:', str(error)[:100])
            else:
                print('player season stats unavailable', player.get('player'), str(error)[:100])

    player.update({key: value for key, value in averages.items() if value is not None})

save('public/data/rosters.json', {
    'updatedAt': now.isoformat(),
    'source': 'ESPN public team roster',
    'teams': rosters_by_team,
    'status': 'available' if rosters_by_team else 'unavailable'
})

enriched_with_ppg = sum(isinstance(x.get('pointsPerGame'), (int, float)) and x.get('pointsPerGame') > 0 for x in injuries)
enriched_with_mpg = sum(isinstance(x.get('minutesPerGame'), (int, float)) and x.get('minutesPerGame') > 0 for x in injuries)
matched_athlete_ids = sum(bool(x.get('athleteId')) for x in injuries)
print('INJURY_ENRICHMENT_DIAGNOSTIC', json.dumps({
    'injuryRows': len(injuries),
    'matchedAthleteIds': matched_athlete_ids,
    'missingAthleteIds': len(injuries) - matched_athlete_ids,
    'withPPG': enriched_with_ppg,
    'withMPG': enriched_with_mpg,
    'source': injury_source
}, ensure_ascii=False))

save('public/data/injuries.json', {
    'updatedAt': now.isoformat(),
    'source': injury_source,
    'sourceUrl': injury_url,
    'players': injuries,
    'status': 'available' if injuries else 'unavailable'
})
sample_counts = [len(row.get('last10', [])) for row in forms.values()]
valid_efficiency = [abbr for abbr, row in team_metrics.items() if not row.get('stale') and isinstance(row.get('offensiveRating'), (int, float)) and isinstance(row.get('defensiveRating'), (int, float))]
print('TEAM_FORM_DIAGNOSTIC', json.dumps({'teams': len(forms), 'teamsWith3Plus': sum(1 for count in sample_counts if count >= 3), 'teamsWith10': sum(1 for count in sample_counts if count >= 10), 'minRecentGames': min(sample_counts) if sample_counts else 0, 'maxRecentGames': max(sample_counts) if sample_counts else 0}, ensure_ascii=False))
print('TEAM_METRICS_DIAGNOSTIC', json.dumps({'teams': len(team_metrics), 'validOffDef': len(valid_efficiency), 'validTeams': valid_efficiency[:30]}, ensure_ascii=False))
print('Saved team form for', len(forms), 'teams;', games_found, 'completed team results; injury rows:', len(injuries), 'source:', injury_source)
