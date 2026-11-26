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

def run_walk_forward(games, recent_weight=0.6, elo_weight=0.0):
    history = {}
    elo_ratings = {}
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
            hpf = recent_weight * avg([x['pointsFor'] for x in home_rows]) + (1 - recent_weight) * avg([x['pointsFor'] for x in h5])
            hpa = recent_weight * avg([x['pointsAgainst'] for x in home_rows]) + (1 - recent_weight) * avg([x['pointsAgainst'] for x in h5])
            apf = recent_weight * avg([x['pointsFor'] for x in away_rows]) + (1 - recent_weight) * avg([x['pointsFor'] for x in a5])
            apa = recent_weight * avg([x['pointsAgainst'] for x in away_rows]) + (1 - recent_weight) * avg([x['pointsAgainst'] for x in a5])
            raw_home, raw_away = (hpf + apa) / 2 + 2.2, (apf + hpa) / 2
            hr, ar = rest_days(home_rows, game['date']), rest_days(away_rows, game['date'])
            hb, ab = hr == 0, ar == 0
            rest_adj = 0 if hr is None or ar is None else max(-2, min(2, hr - ar)) * 0.45
            b2b_adj = (-1.3 if hb else 0) + (1.3 if ab else 0)
            hs, ass = sos(home_rows), sos(away_rows)
            sos_adj = 0 if hs is None or ass is None else (hs - ass) * 0.18
            score_based_margin = (raw_home - raw_away) * 0.78
            home_elo, away_elo = elo_ratings.get(game['homeId'], 1500.0), elo_ratings.get(game['awayId'], 1500.0)
            elo_margin = (home_elo - away_elo) * 0.055 + 2.2
            margin = (1 - elo_weight) * score_based_margin + elo_weight * elo_margin + rest_adj + b2b_adj + sos_adj
            score_total = raw_home + raw_away - (1.3 if hb else 0) - (1.3 if ab else 0)
            # Keep the totals backtest aligned with the live model: 75% matchup
            # score projection + 25% independent recent game-total environment.
            h_totals = [x['pointsFor'] + x['pointsAgainst'] for x in home_rows]
            a_totals = [x['pointsFor'] + x['pointsAgainst'] for x in away_rows]
            h_recent = h_totals[-5:]
            a_recent = a_totals[-5:]
            h_trend = 0.6 * avg(h_recent) + 0.4 * avg(h_totals)
            a_trend = 0.6 * avg(a_recent) + 0.4 * avg(a_totals)
            total_trend = avg([h_trend, a_trend])
            total = score_total * 0.75 + total_trend * 0.25
            recent_totals = h_totals + a_totals
            total_mean = avg(recent_totals)
            total_std_dev = max(14.2, min(20.0, math.sqrt(avg([(x-total_mean)**2 for x in recent_totals]))))
            p_home = min(0.99, max(0.01, cdf(margin / 12.2)))
            predictions.append({
                'gameId': game['id'], 'date': game['date'],
                'homeWin': p_home,
                'awayWin': 1 - p_home,
                'actualHomeWin': 1 if game['homeScore'] > game['awayScore'] else 0,
                'predictedMargin': margin,
                'scoreBasedMargin': score_based_margin,
                'eloMargin': elo_margin,
                'eloWeight': elo_weight,
                'actualMargin': game['homeScore'] - game['awayScore'],
                'predictedTotal': total,
                'totalTrend': total_trend,
                'totalStdDev': total_std_dev,
                'actualTotal': game['homeScore'] + game['awayScore']
            })
        home_rating, away_rating = elo_ratings.get(game['homeId'], 1500.0), elo_ratings.get(game['awayId'], 1500.0)
        expected_home = 1.0 / (1.0 + 10 ** (-((home_rating + 65.0) - away_rating) / 400.0))
        actual_home = 1.0 if game['homeScore'] > game['awayScore'] else 0.5 if game['homeScore'] == game['awayScore'] else 0.0
        margin_of_victory = abs(game['homeScore'] - game['awayScore'])
        mov_multiplier = math.log(margin_of_victory + 1.0) * (2.2 / (2.2 + 0.001 * abs(home_rating - away_rating))) if margin_of_victory else 1.0
        elo_delta = 20.0 * mov_multiplier * (actual_home - expected_home)
        elo_ratings[game['homeId']] = home_rating + elo_delta
        elo_ratings[game['awayId']] = away_rating - elo_delta
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

def residual_stats(training, predicted_key, actual_key):
    errors = [float(row[actual_key]) - float(row[predicted_key]) for row in training
              if isinstance(row.get(predicted_key), (int, float))
              and isinstance(row.get(actual_key), (int, float))]
    if len(errors) < 100:
        return {'mean': 0.0, 'stdDev': None, 'sampleSize': len(errors)}
    mean = avg(errors)
    variance = sum((value - mean) ** 2 for value in errors) / (len(errors) - 1)
    return {'mean': round(mean, 6), 'stdDev': round(math.sqrt(max(variance, 1e-9)), 6), 'sampleSize': len(errors)}


def fit_market_error_calibration(training):
    margin = residual_stats(training, 'predictedMargin', 'actualMargin')
    total = residual_stats(training, 'predictedTotal', 'actualTotal')
    if margin['stdDev'] is None or total['stdDev'] is None:
        return None
    return {
        'marginMean': margin['mean'], 'marginStdDev': margin['stdDev'],
        'totalMean': total['mean'], 'totalStdDev': total['stdDev'],
        'trainingSamples': min(margin['sampleSize'], total['sampleSize'])
    }


def evaluate_market_error_calibration(predictions, calibration):
    if not calibration or not predictions:
        return None
    offsets = (-10.5, -5.5, -0.5, 4.5, 9.5)
    spread_raw, spread_cal, spread_actual = [], [], []
    total_raw, total_cal, total_actual = [], [], []
    for row in predictions:
        margin_error = row['actualMargin'] - row['predictedMargin']
        total_error = row['actualTotal'] - row['predictedTotal']
        for offset in offsets:
            spread_actual.append(1.0 if margin_error + offset > 0 else 0.0)
            spread_raw.append(cdf(offset / 11.8))
            spread_cal.append(cdf((offset + calibration['marginMean']) / calibration['marginStdDev']))
            raw_total_sigma = max(14.2, min(20.0, row.get('totalStdDev', 18.6)))
            total_actual.append(1.0 if total_error > offset else 0.0)
            total_raw.append(cdf(-offset / raw_total_sigma))
            total_cal.append(cdf((calibration['totalMean'] - offset) / calibration['totalStdDev']))
    def summary(raw, calibrated, actual):
        raw_brier = avg([(p-y)**2 for p, y in zip(raw, actual)])
        calibrated_brier = avg([(p-y)**2 for p, y in zip(calibrated, actual)])
        return {
            'sampleSize': len(actual),
            'rawBrier': round(raw_brier, 6),
            'calibratedBrier': round(calibrated_brier, 6),
            'improved': calibrated_brier < raw_brier
        }
    spread = summary(spread_raw, spread_cal, spread_actual)
    totals = summary(total_raw, total_cal, total_actual)
    return {
        'spread': spread, 'totals': totals,
        'spreadValidated': spread['sampleSize'] >= 500 and spread['improved'],
        'totalsValidated': totals['sampleSize'] >= 500 and totals['improved'],
        'evaluationMethod': 'Strict temporal holdout: residual distribution fitted only on completed prior seasons, evaluated on current-season walk-forward forecasts using five half-point offsets around each model projection. This validates probability shape, not profitability.'
    }


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

def market_backtest(predictions, error_calibration=None):
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
                                market_home_win = pred.get('marketHomeWin', pred['homeWin'])
                                prob = market_home_win if is_home else 1 - market_home_win
                                actual = pred['actualHomeWin'] if is_home else 1-pred['actualHomeWin']
                                line = None
                            elif market == 'spreads':
                                point = float(outcome.get('point'))
                                is_home = str(outcome.get('name','')).lower() == str(snap.get('home_team','')).lower()
                                margin = pred['predictedMargin'] if is_home else -pred['predictedMargin']
                                prob = cdf((margin + point + (error_calibration['marginMean'] if error_calibration and error_calibration.get('spreadValidated') else 0.0)) / (error_calibration['marginStdDev'] if error_calibration and error_calibration.get('spreadValidated') else 11.8))
                                actual_margin = pred['actualMargin'] if is_home else -pred['actualMargin']
                                actual = 1 if actual_margin + point > 0 else (0 if actual_margin + point < 0 else 0.5)
                                line = point
                            else:
                                point = float(outcome.get('point'))
                                is_over = str(outcome.get('name','')).lower() in ('over','大')
                                prob = cdf((pred['predictedTotal']+(error_calibration['totalMean'] if error_calibration and error_calibration.get('totalsValidated') else 0.0)-point)/(error_calibration['totalStdDev'] if error_calibration and error_calibration.get('totalsValidated') else pred.get('totalStdDev',14.2))) if is_over else cdf((point-pred['predictedTotal']-(error_calibration['totalMean'] if error_calibration and error_calibration.get('totalsValidated') else 0.0))/(error_calibration['totalStdDev'] if error_calibration and error_calibration.get('totalsValidated') else pred.get('totalStdDev',14.2)))
                                actual_total = pred['actualTotal']
                                actual = 1 if (actual_total > point if is_over else actual_total < point) else (0.5 if actual_total == point else 0)
                                line = point
                            ev = prob * price - 1
                            candidates.append({'probability':prob,'price':price,'ev':ev,'actual':actual,'line':line,'side':outcome.get('name')})
                        except (TypeError, ValueError, KeyError):
                            continue
            # Match the formal production probability/EV gates. Historical
            # injury verification and confidence cannot be reconstructed here.
            qualified = [candidate for candidate in candidates
                         if math.isfinite(candidate['ev']) and candidate['ev'] >= 0.025
                         and math.isfinite(candidate['probability']) and candidate['probability'] >= 0.54]
            if qualified:
                pick = max(qualified, key=lambda x: x['ev'])
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
            'method':'每場僅取開賽前最後一筆台灣運彩快照；僅選擇模型機率至少54%、EV至少+2.5%的方向；歷史傷兵官方確認與信心門檻無法重建，故不計入此回測；固定每注1單位，不含手續費與盤口滑價。正式推薦另須該市場至少50個有效樣本、命中率至少55%、ROI至少+2%，未達標只顯示觀察方向、不列會員推薦。'
        }
    return result

now = datetime.datetime.now(datetime.timezone.utc)
current_season_end_year = now.year if now.month >= 7 else now.year - 1
# Compare the production 60/40 recent-form blend with a less momentum-heavy
# 80/20 candidate using identical chronological game samples.
current_season_games = fetch_season(current_season_end_year + 1)
current_season_predictions = run_walk_forward(current_season_games, 0.6) if current_season_games else []
current_season_candidate = run_walk_forward(current_season_games, 0.8) if current_season_games else []
current_season_elo_candidate = run_walk_forward(current_season_games, 0.6, 0.25) if current_season_games else []
season_years = list(range(current_season_end_year - 2, current_season_end_year + 1))
season_results = []
all_predictions = []
all_candidate_predictions = []
all_elo_predictions = []
calibration_training = []
candidate_calibration_training = []
elo_calibration_training = []
calibrated_predictions = []
candidate_calibrated_predictions = []
elo_calibrated_predictions = []
for season_year in season_years:
    games = fetch_season(season_year)
    if len(games) < 500:
        print('Skipping incomplete season', season_year, 'games:', len(games))
        continue
    predictions = run_walk_forward(games, 0.6)
    candidate_predictions = run_walk_forward(games, 0.8)
    elo_predictions = run_walk_forward(games, 0.6, 0.25)
    if len(predictions) < 300 or len(candidate_predictions) != len(predictions) or len(elo_predictions) != len(predictions):
        print('Skipping insufficient or mismatched prediction season', season_year, 'predictions:', len(predictions), len(candidate_predictions))
        continue
    season_name = f'{season_year-1}-{str(season_year)[-2:]}'
    calibrator = fit_platt(calibration_training)
    candidate_calibrator = fit_platt(candidate_calibration_training)
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
    if candidate_calibrator:
        candidate_calibrated = []
        for row in candidate_predictions:
            item = dict(row)
            item['calibratedHomeWin'] = sigmoid(candidate_calibrator['a'] * logit(row['homeWin']) + candidate_calibrator['b'])
            candidate_calibrated.append(item)
        candidate_calibrated_predictions.extend(candidate_calibrated)
        candidate_calibrated_metrics = probability_metrics(candidate_calibrated, 'calibratedHomeWin')
    else:
        candidate_calibrated_metrics = None
    elo_calibrator_for_season = fit_platt(elo_calibration_training)
    if elo_calibrator_for_season:
        elo_calibrated = []
        for row in elo_predictions:
            item = dict(row)
            item['calibratedHomeWin'] = sigmoid(elo_calibrator_for_season['a'] * logit(row['homeWin']) + elo_calibrator_for_season['b'])
            elo_calibrated.append(item)
        elo_calibrated_predictions.extend(elo_calibrated)
        elo_calibrated_metrics = probability_metrics(elo_calibrated, 'calibratedHomeWin')
    else:
        elo_calibrated_metrics = None
    season_results.append({
        'season': season_name,
        'completedGames': len(games),
        'metrics': metrics(candidate_predictions),
        'baselineMetrics': metrics(predictions),
        'candidateV2Metrics': metrics(candidate_predictions),
        'eloCandidateMetrics': metrics(elo_predictions),
        'calibrationTrainingSamples': len(candidate_calibration_training),
        'calibrator': candidate_calibrator,
        'calibratedMetrics': candidate_calibrated_metrics,
        'baselineCalibrationTrainingSamples': len(calibration_training),
        'baselineCalibrator': calibrator,
        'baselineCalibratedMetrics': calibrated_metrics,
        'candidateV2CalibrationTrainingSamples': len(candidate_calibration_training),
        'candidateV2Calibrator': candidate_calibrator,
        'candidateV2CalibratedMetrics': candidate_calibrated_metrics,
        'eloCandidateCalibrationTrainingSamples': len(elo_calibration_training),
        'eloCandidateCalibrator': elo_calibrator_for_season,
        'eloCandidateCalibratedMetrics': elo_calibrated_metrics
    })
    calibration_training.extend(predictions)
    candidate_calibration_training.extend(candidate_predictions)
    elo_calibration_training.extend(elo_predictions)
    all_predictions.extend(predictions)
    all_candidate_predictions.extend(candidate_predictions)
    all_elo_predictions.extend(elo_predictions)

current_calibrator = next((row.get('calibrator') for row in reversed(season_results) if row.get('calibrator')), None)
candidate_calibrator = next((row.get('candidateV2Calibrator') for row in reversed(season_results) if row.get('candidateV2Calibrator')), None)
elo_calibrator = next((row.get('eloCandidateCalibrator') for row in reversed(season_results) if row.get('eloCandidateCalibrator')), None)
market_predictions = []
for row in current_season_predictions:
    item = dict(row)
    item['marketHomeWin'] = sigmoid(current_calibrator['a'] * logit(row['homeWin']) + current_calibrator['b']) if current_calibrator else row['homeWin']
    market_predictions.append(item)
candidate_market_predictions = []
for row in current_season_candidate:
    item = dict(row)
    item['marketHomeWin'] = sigmoid(candidate_calibrator['a'] * logit(row['homeWin']) + candidate_calibrator['b']) if candidate_calibrator else row['homeWin']
    candidate_market_predictions.append(item)
elo_calibrator = fit_platt(elo_calibration_training) or elo_calibrator
elo_market_predictions = []
for row in current_season_elo_candidate:
    item = dict(row)
    item['marketHomeWin'] = sigmoid(elo_calibrator['a'] * logit(row['homeWin']) + elo_calibrator['b']) if elo_calibrator else row['homeWin']
    elo_market_predictions.append(item)
baseline_market_error_calibration = fit_market_error_calibration(calibration_training)
candidate_market_error_calibration = fit_market_error_calibration(candidate_calibration_training)
elo_market_error_calibration = fit_market_error_calibration(elo_calibration_training)
baseline_market_error_evaluation = evaluate_market_error_calibration(current_season_predictions, baseline_market_error_calibration)
candidate_market_error_evaluation = evaluate_market_error_calibration(current_season_candidate, candidate_market_error_calibration)
elo_market_error_evaluation = evaluate_market_error_calibration(current_season_elo_candidate, elo_market_error_calibration)
if baseline_market_error_calibration:
    baseline_market_error_calibration.update(baseline_market_error_evaluation or {})
if candidate_market_error_calibration:
    candidate_market_error_calibration.update(candidate_market_error_evaluation or {})
if elo_market_error_calibration:
    elo_market_error_calibration.update(elo_market_error_evaluation or {})
current_market_backtest = market_backtest(market_predictions, baseline_market_error_calibration)
candidate_market_backtest = market_backtest(candidate_market_predictions, candidate_market_error_calibration)
elo_market_backtest = market_backtest(elo_market_predictions, elo_market_error_calibration)
def recommendation_ready(market):
    return bool(market and market.get('decided', 0) >= 50
                and market.get('hitRate') is not None and market['hitRate'] >= 0.55
                and market.get('roi') is not None and market['roi'] >= 0.02)

if candidate_market_error_calibration:
    candidate_market_error_calibration['moneylineRecommendationReady'] = recommendation_ready(candidate_market_backtest.get('h2h'))
    candidate_market_error_calibration['spreadRecommendationReady'] = recommendation_ready(candidate_market_backtest.get('spreads')) and candidate_market_error_calibration.get('spreadValidated', False)
    candidate_market_error_calibration['totalsRecommendationReady'] = recommendation_ready(candidate_market_backtest.get('totals')) and candidate_market_error_calibration.get('totalsValidated', False)
if elo_market_error_calibration:
    elo_market_error_calibration['moneylineRecommendationReady'] = recommendation_ready(elo_market_backtest.get('h2h'))
    elo_market_error_calibration['spreadRecommendationReady'] = recommendation_ready(elo_market_backtest.get('spreads')) and elo_market_error_calibration.get('spreadValidated', False)
    elo_market_error_calibration['totalsRecommendationReady'] = recommendation_ready(elo_market_backtest.get('totals')) and elo_market_error_calibration.get('totalsValidated', False)
current_market_backtest['h2h']['method'] += ' 獨贏機率使用前一完整賽季資料訓練的 Platt 校準；讓分及大小分維持原計算。'
candidate_market_backtest['h2h']['method'] += ' 候選 80/20 模型使用其自身前季 Platt 校準；讓分及大小分使用候選模型分差。'
print('Current-season market-only backtest:', current_season_end_year, 'completed games:', len(current_season_games),
      'pregame predictions:', len(current_season_predictions), json.dumps(current_market_backtest, ensure_ascii=False))
print('Candidate 80/20 market-only backtest:', current_season_end_year, 'completed games:', len(current_season_games),
      'pregame predictions:', len(current_season_candidate), json.dumps(candidate_market_backtest, ensure_ascii=False))
print('Elo 25% blend market-only backtest:', current_season_end_year, 'completed games:', len(current_season_games),
      'pregame predictions:', len(current_season_elo_candidate), json.dumps(elo_market_backtest, ensure_ascii=False))

if len(all_predictions) < 900 or len(season_results) < 2:
    raise SystemExit(f'Insufficient multi-season out-of-sample data: {len(all_predictions)} predictions across {len(season_results)} seasons')

v1_metrics = metrics(all_predictions)
candidate_metrics = metrics(all_candidate_predictions)
candidate_improves = bool(candidate_metrics['winnerAccuracy'] is not None and v1_metrics['winnerAccuracy'] is not None
                          and candidate_metrics['winnerAccuracy'] > v1_metrics['winnerAccuracy']
                          and candidate_metrics['brierScore'] is not None and v1_metrics['brierScore'] is not None
                          and candidate_metrics['brierScore'] < v1_metrics['brierScore'])
result = {
    'updatedAt': now.isoformat(),
    'source': 'ESPN completed regular-season schedules',
    'seasons': [row['season'] for row in season_results],
    'method': 'Three-season walk-forward: each game is predicted only from games completed earlier in that same season; current result is appended after prediction.',
    'modelVersion': 'recent-form-pace-v2.0-walkforward-calibration',
    'sampleSize': len(all_predictions),
    'metrics': candidate_metrics,
    'baselineMetrics': v1_metrics,
    'marketBacktest': candidate_market_backtest,
    'marketBacktestBaselineV1': current_market_backtest,
    'marketBacktestCandidateV2': candidate_market_backtest,
    'modelComparison': {
        'baseline': {'version': 'recent-form-pace-v1 (60% last-10 / 40% last-5)', 'metrics': v1_metrics},
        'candidateV2': {'version': 'recent-form-pace-v2-candidate (80% last-10 / 20% last-5)', 'metrics': candidate_metrics},
        'eloCandidate': {'version': 'recent-form-pace-v2-elo-25pct', 'metrics': metrics(all_elo_predictions)},
        'candidateImprovesBothAccuracyAndBrier': candidate_improves,
        'decision': 'candidateV2-promoted-after-improving-walk-forward-accuracy-and-Brier' if candidate_improves else 'keep-baseline; candidate-not-proven-better',
        'policy': 'Do not replace production model unless the candidate improves both walk-forward winner accuracy and Brier Score on identical samples; this is a comparison, not a 70% guarantee.'
    },
    'marketBacktestSeason': f'{current_season_end_year}-{str(current_season_end_year + 1)[-2:]}',
    'marketBacktestPredictionSample': len(current_season_predictions),
    'currentSeason': {
        'season': f'{current_season_end_year}-{str(current_season_end_year + 1)[-2:]}',
        'completedGames': len(current_season_games),
        'predictionSample': len(current_season_predictions),
        'metrics': metrics(current_season_candidate),
        'baselineMetrics': metrics(current_season_predictions),
        'candidateV2Metrics': metrics(current_season_candidate),
        'eloCandidateMetrics': metrics(current_season_elo_candidate),
        'eloMarketBacktest': elo_market_backtest,
        'eloMarketErrorCalibration': elo_market_error_calibration,
        'calibrator': fit_platt(candidate_calibration_training + current_season_candidate),
        'calibrationTrainingSamples': len(candidate_calibration_training) + len(current_season_candidate),
        'marketErrorCalibration': candidate_market_error_calibration
    },
    'seasonResults': season_results,
    'calibration': calibration(all_candidate_predictions),
    'baselineCalibration': calibration(all_predictions),
    'calibrationEvaluation': {
        'method': 'Regularized Platt scaling; each season is calibrated only with predictions from earlier seasons. The first season is excluded because no prior-season training data exists.',
        'trainingPolicy': 'strictly chronological; no same-season outcomes are used to fit that season calibrator',
        'sampleSize': len(candidate_calibrated_predictions),
        'rawMetrics': probability_metrics(candidate_calibrated_predictions, 'homeWin') if candidate_calibrated_predictions else None,
        'calibratedMetrics': probability_metrics(candidate_calibrated_predictions, 'calibratedHomeWin') if candidate_calibrated_predictions else None,
        'improvedBrier': (probability_metrics(candidate_calibrated_predictions, 'calibratedHomeWin')['brierScore'] < probability_metrics(candidate_calibrated_predictions, 'homeWin')['brierScore']) if candidate_calibrated_predictions else None
    },
    'candidateV2CalibrationEvaluation': {
        'sampleSize': len(candidate_calibrated_predictions),
        'rawMetrics': probability_metrics(candidate_calibrated_predictions, 'homeWin') if candidate_calibrated_predictions else None,
        'calibratedMetrics': probability_metrics(candidate_calibrated_predictions, 'calibratedHomeWin') if candidate_calibrated_predictions else None,
        'improvedBrier': (probability_metrics(candidate_calibrated_predictions, 'calibratedHomeWin')['brierScore'] < probability_metrics(candidate_calibrated_predictions, 'homeWin')['brierScore']) if candidate_calibrated_predictions else None
    },
    'limitations': [
        'Candidate V2 changes only the last-10 versus last-5 weighting from 60/40 to 80/20; all other model factors and chronological samples are held constant.',
        'Historical injury reports and player availability are not reconstructed; injury adjustment is not included in this historical test.',
        '獨贏三季回測與市場盤口回測分開：讓分及大小分只使用當季可配對的開賽前台灣運彩快照；沒有歷史盤口的往季不補造盤口。',
        'Each season starts with an empty team form history; the first three completed games per team are warm-up data and are not predicted.',
        'Probability calibration is fitted on prior seasons only and evaluated on later held-out seasons; it is not proof of future performance.',
        'Spread and total residual distributions are fitted on prior seasons only; the current season is a temporal holdout. A market is recommendation-eligible only when its probability calibration improves the synthetic-line Brier test; this is not a guarantee of positive ROI.'
    ]
}
pathlib.Path('public/data').mkdir(parents=True, exist_ok=True)
pathlib.Path('public/data/backtest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print('Saved multi-season walk-forward backtest:', len(all_predictions), 'predictions across', len(season_results), 'seasons', json.dumps(result['metrics']))
print('Current-season winner/score backtest:', json.dumps(result['currentSeason'], ensure_ascii=False))
print('Separate Taiwan market backtest (h2h / totals / spreads):', json.dumps(result['marketBacktest'], ensure_ascii=False))
print('MODEL_COMPARISON_V1_VS_CANDIDATE_V2:', json.dumps(result['modelComparison'], ensure_ascii=False))
