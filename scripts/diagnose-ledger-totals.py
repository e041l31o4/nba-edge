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
        return {"n": 0, "bias": None, "mae": None, "rmse": None, "residualStdDev": None, "overForecastPct": None, "underForecastPct": None, "within5Pct": None}
    bias = sum(errors) / n
    return {
        "n": n,
        "bias": round(bias, 3),
        "mae": round(sum(abs(x) for x in errors) / n, 3),
        "rmse": round(math.sqrt(sum(x*x for x in errors) / n), 3),
        "residualStdDev": round(math.sqrt(sum((x-bias)**2 for x in errors) / n), 3),
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
by_month, by_band, by_pace, by_version = (collections.defaultdict(list) for _ in range(4))
for row in settled:
    date = str(row.get("date", ""))[:7]
    if len(date) == 7:
        by_month[date].append(row)
    total = float(row["projectedTotal"])
    band = "<215" if total < 215 else "215-224.9" if total < 225 else "225-234.9" if total < 235 else "235-244.9" if total < 245 else "245+"
    by_band[band].append(row)
    version = str(row.get("modelVersion") or "legacy-untracked")
    by_version[version].append(row)
    pace = row.get("paceAdjustment")
    if isinstance(pace, (int, float)):
        pace_band = "<0" if pace < 0 else "0-1.9" if pace < 2 else "2-3.9" if pace < 4 else "4-5.9" if pace < 6 else "6-cap"
        by_pace[pace_band].append(row)

report = {
    "updatedAt": payload.get("updatedAt") if isinstance(payload, dict) else None,
    "ledgerRecords": len(records),
    "officialRecords": sum(1 for r in records if r.get("stage") == "official"),
    "settledOfficialRecords": len(settled),
    "overall": metrics(settled),
    "byMonth": {k: metrics(v) for k, v in sorted(by_month.items())},
    "byProjectedTotalBand": {k: metrics(v) for k, v in by_band.items()},
    "byModelVersion": {k: metrics(v) for k, v in by_version.items()},
    "byPaceAdjustmentBand": {k: metrics(v) for k, v in by_pace.items()},
    "featureCoverage": {
        "withPaceAdjustment": sum(isinstance(r.get("paceAdjustment"), (int, float)) for r in settled),
        "withTotalTrend": sum(isinstance(r.get("totalTrend"), (int, float)) for r in settled),
        "withTotalStdDev": sum(isinstance(r.get("totalStdDev"), (int, float)) for r in settled),
        "withInjuryImpact": sum(isinstance(r.get("homeInjuryImpact"), (int, float)) and isinstance(r.get("awayInjuryImpact"), (int, float)) for r in settled),
        "withModelVersion": sum(bool(r.get("modelVersion")) for r in settled),
    },
    "limitations": [
        "Measures locked pregame projected-total error, not Over/Under hit rate or ROI; historical market lines and odds are not stored in the immutable prediction ledger.",
        "Historical rows without feature fields are grouped as legacy-untracked; no missing Pace or injury values are reconstructed.",
        "Draft rows are excluded. Feature-level conclusions require enough settled official records from the tagged model version."
    ]
}
print("NBA_EDGE_LEDGER_TOTALS_BACKTEST " + json.dumps(report, ensure_ascii=False))
if len(settled) < 30:
    print("WARNING: Fewer than 30 settled official total forecasts; treat aggregate error metrics as preliminary.")
