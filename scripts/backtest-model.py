import json, math, datetime, urllib.request, pathlib

BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
HEAD = {'User-Agent': 'Mozilla/5.0 NBA-EDGE-backtest/2.0'}

def get(url):
    req = urllib.request.Request(url, headers=HEAD)
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)

def completed(event):
    comp = (event.get('competitions') or [{}])[0]
    status = event.get('status') or comp.get('status') or {}
    typ = status.get('type') or {}
    return typ.get('completed') is True or str(typ.get('state') or '').lower() in ('post', 'final')

def score(value):
    if isinstance(value, dict):
        value = value.get('value', value.get('displayValue'))
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

def avg(values):
    return sum(values) / len(values) if values else 0.0

def cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))

def fetch_season(season):
    league = get(BASE + '/teams?limit=40')
    teams = league.get('sports', [{}])[0].get('leagues', [{}])[0].get('teams', [])
    events_by_id = {}
    for item in teams:
        team = item.get('team', {})
        team_id = str(team.get('id') or '')
        if not team_id:
            continue
        try:
            payload = get(f'{BASE}/teams/{team_id}/schedule?season={season}')
            for event in payload.get('events', []):
                if not completed(event):
                    continue
                season_meta = event.get('season') or {}
                if season_meta.get('type') is not None and str(season_meta.get('type')) != '2':
                    continue
                comp = (event.get('competitions') or [{}])[0]
                competitors = comp.get('competitors') or []
                home = next((x for x in competitors if x.get('homeAway') == 'home'), None)
                away = next((x for x in competitors if x.get('homeAway') == 'away'), None)
                if not home or not away:
                    continue
                home_id = str((home.get('team') or {}).get('id') or '')
                away_id = str((away.get('team') or {}).get('id') or '')
                hp, ap = score(home.get('score')), score(away.get('score'))
                if not home_id or not away_id or hp is None or ap is None:
                    continue
                event_id = str(event.get('id') or comp.get('id') or '')
                if not event_id:
                    continue
                events_by_id[event_id] = {
                    'id': event_id, 'date': event.get('date') or comp.get('date'),
                    'homeId': home_id, 'awayId': away_id,
                    'home': (home.get('team') or {}).get('abbreviation', home_id),
                    'away': (away.get('team') or {}).get('abbreviation', away_id),
                    'homeScore': hp, 'awayScore': ap
                }
        except Exception as error:
            print('schedule skipped', season, team_id, str(error)[:120])
    return sorted(events_by_id.values(), key=lambda x: x.get('date') or '')

def run_walk_forward(games):
    history = {}
    predictions = []
    def team_rows(team_id):
        return history.get(team_id, [])[-10:]
    def sos(rows):
        values = []
        for row in rows:
            opponent_rows = team_rows(row['opponentId'])
            if len(opponent_rows) >= 5:
                values.append(avg([x['pointsFor'] - x['pointsAgainst'] for x in opponent_rows]))
        return avg(values) if len(values) >= 3 else None
    def rest_days(rows, game_date):
        if not rows:
            return None
        last = datetime.datetime.fromisoformat(rows[-1]['date'].replace('Z', '+00:00'))
        current = datetime.datetime.fromisoformat(game_date.replace('Z', '+00:00'))
        elapsed_days = math.floor((current - last).total_seconds() / 86400)
        return max(0, elapsed_days - 1)
    for game in games:
        home_rows, away_rows = team_rows(game['homeId']), team_rows(game['awayId'])
        if len(home_rows) >= 3 and len(away_rows) >= 3:
            h5, a5 = home_rows[-5:], away_rows[-5:]
            hpf = 0.6 * avg([x['pointsFor'] for x in home_rows]) + 0.4 * avg([x['pointsFor'] for x in h5])
            hpa = 0.6 * avg([x['pointsAgainst'] for x in home_rows]) + 0.4 * avg([x['pointsAgainst'] for x in h5])
            apf = 0.6 * avg([x['pointsFor'] for x in away_rows]) + 0.4 * avg([x['pointsFor'] for x in a5])
            apa = 0.6 * avg([x['pointsAgainst'] for x in away_rows]) + 0.4 * avg([x['pointsAgainst'] for x in a5])
            raw_home, raw_away = (hpf + apa) / 2 + 2.2, (apf + hpa) / 2
            hr, ar = rest_days(home_rows, game['date']), rest_days(away_rows, game['date'])
            hb, ab = hr == 0, ar == 0
            rest_adj = 0 if hr is None or ar is None else max(-2, min(2, hr - ar)) * 0.45
            b2b_adj = (-1.3 if hb else 0) + (1.3 if ab else 0)
            hs, ass = sos(home_rows), sos(away_rows)
            sos_adj = 0 if hs is None or ass is None else (hs - ass) * 0.18
            margin = (raw_home - raw_away) * 0.78 + rest_adj + b2b_adj + sos_adj
            total = raw_home + raw_away - (1.3 if hb else 0) - (1.3 if ab else 0)
            p_home = min(0.99, max(0.01, cdf(margin / 12.2)))
            predictions.append({
                'homeWin': p_home,
                'actualHomeWin': 1 if game['homeScore'] > game['awayScore'] else 0,
                'predictedMargin': margin,
                'actualMargin': game['homeScore'] - game['awayScore'],
                'predictedTotal': total,
                'actualTotal': game['homeScore'] + game['awayScore']
            })
        history.setdefault(game['homeId'], []).append({
            'date': game['date'], 'pointsFor': game['homeScore'], 'pointsAgainst': game['awayScore'],
            'win': game['homeScore'] > game['awayScore'], 'opponentId': game['awayId']
        })
        history.setdefault(game['awayId'], []).append({
            'date': game['date'], 'pointsFor': game['awayScore'], 'pointsAgainst': game['homeScore'],
            'win': game['awayScore'] > game['homeScore'], 'opponentId': game['homeId']
        })
    return predictions

def metrics(predictions):
    n = len(predictions)
    if not n:
        return {'sampleSize': 0, 'winnerAccuracy': None, 'brierScore': None, 'marginMAE': None, 'totalMAE': None}
    accuracy = sum((p['homeWin'] >= 0.5) == bool(p['actualHomeWin']) for p in predictions) / n
    brier = avg([(p['homeWin'] - p['actualHomeWin']) ** 2 for p in predictions])
    margin_mae = avg([abs(p['predictedMargin'] - p['actualMargin']) for p in predictions])
    total_mae = avg([abs(p['predictedTotal'] - p['actualTotal']) for p in predictions])
    return {
        'sampleSize': n, 'winnerAccuracy': round(accuracy, 5),
        'brierScore': round(brier, 5), 'marginMAE': round(margin_mae, 3),
        'totalMAE': round(total_mae, 3)
    }

def calibration(predictions):
    bands = [(0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70),
             (0.70, 0.75), (0.75, 0.80), (0.80, 0.90), (0.90, 1.001)]
    rows = []
    for lower, upper in bands:
        subset = [p for p in predictions if lower <= p['homeWin'] < upper]
        if subset:
            rows.append({
                'range': f'{int(lower*100)}-{min(100,int((upper if upper < 1 else 1)*100))}%',
                'sampleSize': len(subset),
                'predictedHomeWin': round(avg([p['homeWin'] for p in subset]), 4),
                'actualHomeWin': round(avg([p['actualHomeWin'] for p in subset]), 4)
            })
    return rows

now = datetime.datetime.now(datetime.timezone.utc)
current_season_end_year = now.year if now.month >= 7 else now.year - 1
# Three most recently completed seasons; season identifiers use the ending year.
season_years = list(range(current_season_end_year - 2, current_season_end_year + 1))
season_results = []
all_predictions = []
for season_year in season_years:
    games = fetch_season(season_year)
    if len(games) < 500:
        print('Skipping incomplete season', season_year, 'games:', len(games))
        continue
    predictions = run_walk_forward(games)
    if len(predictions) < 300:
        print('Skipping insufficient prediction season', season_year, 'predictions:', len(predictions))
        continue
    all_predictions.extend(predictions)
    season_results.append({
        'season': f'{season_year-1}-{str(season_year)[-2:]}',
        'completedGames': len(games),
        'metrics': metrics(predictions)
    })

if len(all_predictions) < 900 or len(season_results) < 2:
    raise SystemExit(f'Insufficient multi-season out-of-sample data: {len(all_predictions)} predictions across {len(season_results)} seasons')

result = {
    'updatedAt': now.isoformat(),
    'source': 'ESPN completed regular-season schedules',
    'seasons': [row['season'] for row in season_results],
    'method': 'Three-season walk-forward: each game is predicted only from games completed earlier in that same season; current result is appended after prediction.',
    'modelVersion': 'odds-blind-v3-multiseason',
    'sampleSize': len(all_predictions),
    'metrics': metrics(all_predictions),
    'seasonResults': season_results,
    'calibration': calibration(all_predictions),
    'limitations': [
        'Historical injury reports and player availability are not reconstructed; the injury adjustment is not included in this historical test.',
        'No historical betting odds are used; ATS, totals market hit rate and ROI are not calculated.',
        'Each season starts with an empty team form history; the first three completed games per team are warm-up data and are not predicted.',
        'This retrospective multi-season walk-forward test is not proof of future performance.'
    ]
}
pathlib.Path('public/data').mkdir(parents=True, exist_ok=True)
pathlib.Path('public/data/backtest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print('Saved multi-season walk-forward backtest:', len(all_predictions), 'predictions across', len(season_results), 'seasons', json.dumps(result['metrics']))
