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
                'gameId': game['id'], 'date': game['date'],
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

def logit(p):
    p = min(0.999, max(0.001, p))
    return math.log(p / (1 - p))

def sigmoid(x):
    if x >= 0:
        z = math.exp(-min(x, 40))
        return 1 / (1 + z)
    z = math.exp(max(x, -40))
    return z / (1 + z)

def fit_platt(training):
    # Regularized Platt scaling fitted only on earlier seasons.
    if len(training) < 200:
        return None
    a, b = 1.0, 0.0
    xs = [logit(p['homeWin']) for p in training]
    ys = [p['actualHomeWin'] for p in training]
    for _ in range(80):
        g1 = g2 = h11 = h12 = h22 = 0.0
        for x, y in zip(xs, ys):
            q = sigmoid(a * x + b)
            d, w = q - y, q * (1 - q)
            g1 += d * x; g2 += d
            h11 += w * x * x; h12 += w * x; h22 += w
        n = len(xs)
        g1, g2 = g1 / n + 0.01 * (a - 1), g2 / n + 0.01 * b
        h11, h12, h22 = h11 / n + 0.01, h12 / n, h22 / n + 0.01
        det = h11 * h22 - h12 * h12
        if abs(det) < 1e-12: break
        da, db = (h22*g1-h12*g2)/det, (-h12*g1+h11*g2)/det
        a -= max(-1.0, min(1.0, da)); b -= max(-1.0, min(1.0, db))
        if abs(da) + abs(db) < 1e-7: break
    return {'a': round(a, 6), 'b': round(b, 6), 'trainingSamples': len(training)}

def probability_metrics(predictions, probability_key):
    n = len(predictions)
    if not n:
        return {'sampleSize': 0, 'winnerAccuracy': None, 'brierScore': None, 'logLoss': None}
    probs = [min(0.999, max(0.001, p[probability_key])) for p in predictions]
    ys = [p['actualHomeWin'] for p in predictions]
    return {
        'sampleSize': n,
        'winnerAccuracy': round(avg([1 if (p >= 0.5) == bool(y) else 0 for p, y in zip(probs, ys)]), 5),
        'brierScore': round(avg([(p-y)**2 for p, y in zip(probs, ys)]), 5),
        'logLoss': round(avg([-y*math.log(p)-(1-y)*math.log(1-p) for p, y in zip(probs, ys)]), 5)
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

def read_odds_history():
    path = pathlib.Path('public/data/odds-history.jsonl')
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            item = json.loads(line)
            captured = datetime.datetime.fromisoformat(str(item.get('capturedAt','')).replace('Z','+00:00'))
            commence = datetime.datetime.fromisoformat(str(item.get('commence_time','')).replace('Z','+00:00'))
            if captured.tzinfo is None: captured = captured.replace(tzinfo=datetime.timezone.utc)
            if commence.tzinfo is None: commence = commence.replace(tzinfo=datetime.timezone.utc)
            if captured >= commence:
                continue
            if 'taiwan sports lottery' not in str(item.get('source','')).lower() and '台灣運彩' not in str(item.get('source','')):
                continue
            rows.append(item)
        except Exception:
            continue
    return rows

def market_backtest(predictions):
    # Only use a real, timestamped Taiwan Sports Lottery snapshot captured before tipoff.
    # Missing historical lines are excluded, never reconstructed from closing scores.
    odds_by_game = {}
    for row in read_odds_history():
        gid = str(row.get('gameId') or '')
        if not gid: continue
        odds_by_game.setdefault(gid, []).append(row)
    result = {}
    for market in ('h2h', 'spreads', 'totals'):
        bets = []
        for pred in predictions:
            snapshots = odds_by_game.get(str(pred.get('gameId')), [])
            if not snapshots: continue
            snap = max(snapshots, key=lambda x: x.get('capturedAt',''))
            books = snap.get('bookmakers') or []
            candidates = []
            for book in books:
                title = str(book.get('title',''))
                if '台灣運彩' not in title and 'taiwan sports lottery' not in title.lower(): continue
                for m in book.get('markets') or []:
                    if m.get('key') != market: continue
                    outcomes = m.get('outcomes') or []
                    if len(outcomes) < 2: continue
                    for outcome in outcomes:
                        try:
                            price = float(outcome.get('price'))
                            if price <= 1: continue
                            if market == 'h2h':
                                is_home = str(outcome.get('name','')).lower() in ('home', str(snap.get('home_team','')).lower())
                                prob = pred['homeWin'] if is_home else pred['awayWin']
                                actual = pred['actualHomeWin'] if is_home else 1-pred['actualHomeWin']
                                line = None
                            elif market == 'spreads':
                                point = float(outcome.get('point'))
                                is_home = str(outcome.get('name','')).lower() == str(snap.get('home_team','')).lower()
                                margin = pred['predictedMargin'] if is_home else -pred['predictedMargin']
                                prob = cdf((margin + point) / 11.8)
                                actual_margin = pred['actualMargin'] if is_home else -pred['actualMargin']
                                actual = 1 if actual_margin + point > 0 else (0 if actual_margin + point < 0 else 0.5)
                                line = point
                            else:
                                point = float(outcome.get('point'))
                                is_over = str(outcome.get('name','')).lower() in ('over','大')
                                prob = cdf((pred['predictedTotal']-point)/14.2) if is_over else cdf((point-pred['predictedTotal'])/14.2)
                                actual_total = pred['actualTotal']
                                actual = 1 if (actual_total > point if is_over else actual_total < point) else (0.5 if actual_total == point else 0)
                                line = point
                            ev = prob * price - 1
                            candidates.append({'probability':prob,'price':price,'ev':ev,'actual':actual,'line':line,'side':outcome.get('name')})
                        except (TypeError, ValueError, KeyError):
                            continue
            if candidates:
                pick = max(candidates, key=lambda x: x['ev'])
                bets.append(pick)
        decided = [b for b in bets if b['actual'] != 0.5]
        wins = sum(1 for b in decided if b['actual'] == 1)
        pushes = len(bets)-len(decided)
        profit = sum((b['price']-1) if b['actual']==1 else (-1 if b['actual']==0 else 0) for b in bets)
        n = len(bets)
        result[market] = {
            'sampleSize':n,'decided':len(decided),'wins':wins,'losses':len(decided)-wins,'pushes':pushes,
            'hitRate': round(wins/len(decided),5) if decided else None,
            'roi': round(profit/n,5) if n else None,
            'netUnits': round(profit,3),
            'averageEV': round(avg([b['ev'] for b in bets]),5) if bets else None,
            'method':'每場僅取開賽前最後一筆台灣運彩快照；依模型機率計算雙邊 EV，選 EV 較高方向；固定每注 1 單位，不含手續費與盤口滑價。'
        }
    return result

now = datetime.datetime.now(datetime.timezone.utc)
current_season_end_year = now.year if now.month >= 7 else now.year - 1
# Three most recently completed seasons; season identifiers use the ending year.
season_years = list(range(current_season_end_year - 2, current_season_end_year + 1))
season_results = []
all_predictions = []
calibration_training = []
calibrated_predictions = []
for season_year in season_years:
    games = fetch_season(season_year)
    if len(games) < 500:
        print('Skipping incomplete season', season_year, 'games:', len(games))
        continue
    predictions = run_walk_forward(games)
    if len(predictions) < 300:
        print('Skipping insufficient prediction season', season_year, 'predictions:', len(predictions))
        continue
    season_name = f'{season_year-1}-{str(season_year)[-2:]}'
    calibrator = fit_platt(calibration_training)
    if calibrator:
        calibrated = []
        for row in predictions:
            item = dict(row)
            item['calibratedHomeWin'] = sigmoid(calibrator['a'] * logit(row['homeWin']) + calibrator['b'])
            calibrated.append(item)
        calibrated_predictions.extend(calibrated)
        calibrated_metrics = probability_metrics(calibrated, 'calibratedHomeWin')
    else:
        calibrated_metrics = None
    season_results.append({
        'season': season_name,
        'completedGames': len(games),
        'metrics': metrics(predictions),
        'calibrationTrainingSamples': len(calibration_training),
        'calibrator': calibrator,
        'calibratedMetrics': calibrated_metrics
    })
    calibration_training.extend(predictions)
    all_predictions.extend(predictions)

if len(all_predictions) < 900 or len(season_results) < 2:
    raise SystemExit(f'Insufficient multi-season out-of-sample data: {len(all_predictions)} predictions across {len(season_results)} seasons')

result = {
    'updatedAt': now.isoformat(),
    'source': 'ESPN completed regular-season schedules',
    'seasons': [row['season'] for row in season_results],
    'method': 'Three-season walk-forward: each game is predicted only from games completed earlier in that same season; current result is appended after prediction.',
    'modelVersion': 'odds-blind-v4-walkforward-calibration',
    'sampleSize': len(all_predictions),
    'metrics': metrics(all_predictions),
    'marketBacktest': market_backtest(all_predictions),
    'seasonResults': season_results,
    'calibration': calibration(all_predictions),
    'calibrationEvaluation': {
        'method': 'Regularized Platt scaling; each season is calibrated only with predictions from earlier seasons. The first season is excluded because no prior-season training data exists.',
        'trainingPolicy': 'strictly chronological; no same-season outcomes are used to fit that season calibrator',
        'sampleSize': len(calibrated_predictions),
        'rawMetrics': probability_metrics(calibrated_predictions, 'homeWin') if calibrated_predictions else None,
        'calibratedMetrics': probability_metrics(calibrated_predictions, 'calibratedHomeWin') if calibrated_predictions else None,
        'improvedBrier': (probability_metrics(calibrated_predictions, 'calibratedHomeWin')['brierScore'] < probability_metrics(calibrated_predictions, 'homeWin')['brierScore']) if calibrated_predictions else None
    },
    'limitations': [
        'Historical injury reports and player availability are not reconstructed; the injury adjustment is not included in this historical test.',
        '讓分與大小分只在存在開賽前台灣運彩歷史快照的場次計算；沒有歷史盤口的場次不納入市場回測。',
        'Each season starts with an empty team form history; the first three completed games per team are warm-up data and are not predicted.',
        'Probability calibration is fitted on prior seasons only and evaluated on later held-out seasons; it is not proof of future performance.'
    ]
}
pathlib.Path('public/data').mkdir(parents=True, exist_ok=True)
pathlib.Path('public/data/backtest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print('Saved multi-season walk-forward backtest:', len(all_predictions), 'predictions across', len(season_results), 'seasons', json.dumps(result['metrics']))
print('Separate Taiwan market backtest (h2h / totals / spreads):', json.dumps(result['marketBacktest'], ensure_ascii=False))
