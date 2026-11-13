import json, pathlib, math, collections

path = pathlib.Path("public/data/prediction-ledger.json")
if not path.exists():
    raise SystemExit("prediction-ledger.json missing; cannot validate historical total forecasts")
payload = json.loads(path.read_text(encoding="utf-8"))
records = payload.get("records", []) if isinstance(payload, dict) else []

def metrics(rows):
    errors = [float(r["projectedTotal"]) - (float(r["actualHome"]) + float(r["actualAway"])) for r in rows]
    n = len(errors)
    if not n:
        return {"n": 0, "bias": None, "mae": None, "rmse": None, "overForecastPct": None, "underForecastPct": None, "within5Pct": None}
    return {
        "n": n,
        "bias": round(sum(errors) / n, 3),
        "mae": round(sum(abs(x) for x in errors) / n, 3),
        "rmse": round(math.sqrt(sum(x*x for x in errors) / n), 3),
        "overForecastPct": round(sum(x > 0 for x in errors) / n * 100, 1),
        "underForecastPct": round(sum(x < 0 for x in errors) / n * 100, 1),
        "within5Pct": round(sum(abs(x) <= 5 for x in errors) / n * 100, 1),
    }

settled = [
    r for r in records
    if r.get("stage") == "official" and r.get("settledAt")
    and isinstance(r.get("projectedTotal"), (int, float))
    and isinstance(r.get("actualHome"), (int, float))
    and isinstance(r.get("actualAway"), (int, float))
]
by_season = collections.defaultdict(list)
by_month = collections.defaultdict(list)
by_band = collections.defaultdict(list)
for row in settled:
    date = str(row.get("date", ""))[:10]
    if len(date) >= 7:
        by_season[date[:4] + "-" + str((int(date[5:7]) + 6 - 1)//12 + int(date[:4]))[-2:]].append(row)
        by_month[date[:7]].append(row)
    total = float(row["projectedTotal"])
    band = "<215" if total < 215 else "215-224.9" if total < 225 else "225-234.9" if total < 235 else "235-244.9" if total < 245 else "245+"
    by_band[band].append(row)

report = {
    "updatedAt": payload.get("updatedAt") if isinstance(payload, dict) else None,
    "ledgerRecords": len(records),
    "officialRecords": sum(1 for r in records if r.get("stage") == "official"),
    "settledOfficialRecords": len(settled),
    "overall": metrics(settled),
    "byMonth": {k: metrics(v) for k, v in sorted(by_month.items())},
    "byProjectedTotalBand": {k: metrics(v) for k, v in by_band.items()},
    "limitations": [
        "This evaluates locked pregame projected totals against final scores; it does not evaluate Over/Under hit rate or ROI because the ledger does not preserve historical market lines, odds, or side probabilities.",
        "The ledger does not store the Pace adjustment separately, so historical Pace contribution cannot be isolated from this dataset.",
        "Only settled official predictions are included; draft rows are excluded."
    ]
}
print("NBA_EDGE_LEDGER_TOTALS_BACKTEST " + json.dumps(report, ensure_ascii=False))
if len(settled) < 30:
    print("WARNING: Fewer than 30 settled official total forecasts; treat aggregate error metrics as preliminary.")
