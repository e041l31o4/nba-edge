#!/usr/bin/env python3
"""Read-only aggregate audit of the private NBA EDGE prediction ledger.

This script never changes prediction-ledger.json. It emits only aggregate
metrics to audit/ledger-audit.json so the private game-by-game ledger stays
inside Supabase.
"""
import collections
import datetime as dt
import json
import math
import pathlib
import statistics

SOURCE = pathlib.Path("public/data/prediction-ledger.json")
OUT = pathlib.Path("audit/ledger-audit.json")

def avg(xs):
    return round(sum(xs) / len(xs), 4) if xs else None

def rate_summary(rows, key):
    wins = sum(1 for r in rows if (r.get(key) or {}).get("result") == "win")
    losses = sum(1 for r in rows if (r.get(key) or {}).get("result") == "loss")
    pushes = sum(1 for r in rows if (r.get(key) or {}).get("result") == "push")
    graded = wins + losses + pushes
    decided = wins + losses
    prices = [float((r.get(key) or {}).get("price")) for r in rows
              if (r.get(key) or {}).get("result") in ("win", "loss", "push")
              and isinstance((r.get(key) or {}).get("price"), (int, float))
              and float((r.get(key) or {}).get("price")) > 1]
    profit = 0.0
    priced_bets = 0
    for r in rows:
        p = r.get(key) or {}
        if p.get("result") not in ("win", "loss", "push"):
            continue
        try:
            price = float(p.get("price"))
            if price <= 1: continue
        except (TypeError, ValueError):
            continue
        priced_bets += 1
        profit += price - 1 if p["result"] == "win" else (-1 if p["result"] == "loss" else 0)
    return {
        "graded": graded, "decided": decided, "wins": wins, "losses": losses,
        "pushes": pushes, "hitRate": round(wins / decided, 4) if decided else None,
        "pricedBets": priced_bets,
        "netUnits": round(profit, 3) if priced_bets else None,
        "roi": round(profit / priced_bets, 4) if priced_bets else None,
        "avgDecimalOdds": avg(prices),
        "missingResult": sum(1 for r in rows if (r.get(key) or {}).get("result") not in ("win", "loss", "push"))
    }

def group_summary(rows, group_fn, market_key=None):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[group_fn(row)].append(row)
    result = {}
    for name, subset in sorted(groups.items()):
        if market_key:
            result[name] = rate_summary(subset, market_key)
        else:
            result[name] = moneyline_summary(subset)
    return result

def moneyline_summary(rows):
    settled = [r for r in rows if isinstance(r.get("actualHome"), (int, float)) and isinstance(r.get("actualAway"), (int, float))]
    correct = 0
    for r in settled:
        p = r.get("homeWin")
        if isinstance(p, (int, float)) and math.isfinite(p):
            correct += int((p >= 0.5) == (r["actualHome"] > r["actualAway"]))
    probs, labels, margins, totals = [], [], [], []
    for r in settled:
        p = r.get("homeWin")
        if isinstance(p, (int, float)) and math.isfinite(p):
            y = 1 if r["actualHome"] > r["actualAway"] else 0
            probs.append((p-y)**2)
            labels.append((p, y))
        if isinstance(r.get("projectedMargin"), (int, float)):
            margins.append(abs(r["projectedMargin"] - (r["actualHome"] - r["actualAway"])))
        if isinstance(r.get("projectedTotal"), (int, float)):
            totals.append(abs(r["projectedTotal"] - (r["actualHome"] + r["actualAway"])))
    return {
        "settled": len(settled),
        "winnerAccuracy": round(correct / len(settled), 4) if settled else None,
        "brierScore": avg(probs),
        "marginMAE": avg(margins),
        "totalMAE": avg(totals)
    }

if not SOURCE.exists():
    raise SystemExit("Private prediction ledger was not restored; no audit was generated.")
payload = json.loads(SOURCE.read_text(encoding="utf-8"))
records = payload.get("records", []) if isinstance(payload, dict) else []
official = [r for r in records if r.get("stage") == "official"]
settled = [r for r in official if r.get("settledAt") and isinstance(r.get("actualHome"), (int, float)) and isinstance(r.get("actualAway"), (int, float))]
spread_rows = [r for r in official if r.get("spreadPick")]
total_rows = [r for r in official if r.get("totalPick")]

def date_of(r):
    return str(r.get("date") or "")[:10]

def month_of(r):
    return date_of(r)[:7] or "unknown"

def week_of(r):
    try:
        d = dt.date.fromisoformat(date_of(r))
        y, w, _ = d.isocalendar()
        return f"{y}-W{w:02d}"
    except Exception:
        return "unknown"

def version_of(r):
    return str(r.get("modelVersion") or "legacy-untracked")

def probability_band(r, key):
    p = (r.get(key) or {}).get("probability")
    if not isinstance(p, (int, float)): return "missing"
    return "<50%" if p < .5 else "50-54.9%" if p < .55 else "55-59.9%" if p < .6 else "60-64.9%" if p < .65 else "65-69.9%" if p < .7 else "70-74.9%" if p < .75 else "75%+"

def ev_band(r, key):
    ev = (r.get(key) or {}).get("ev")
    if not isinstance(ev, (int, float)): return "missing"
    return "<0%" if ev < 0 else "0-2.9%" if ev < .03 else "3-5.9%" if ev < .06 else "6-9.9%" if ev < .10 else "10%+"

report = {
    "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    "source": "private Supabase prediction-ledger; aggregate-only report",
    "counts": {
        "allRecords": len(records), "official": len(official), "settledOfficial": len(settled),
        "unsettledOfficial": len(official) - len(settled),
        "spreadPicks": len(spread_rows), "totalPicks": len(total_rows),
        "modelVersions": dict(collections.Counter(version_of(r) for r in official))
    },
    "overall": {
        "moneyline": moneyline_summary(official),
        "spread": rate_summary(spread_rows, "spreadPick"),
        "totals": rate_summary(total_rows, "totalPick")
    },
    "byMonth": {
        "moneyline": group_summary(settled, month_of),
        "spread": group_summary(spread_rows, month_of, "spreadPick"),
        "totals": group_summary(total_rows, month_of, "totalPick")
    },
    "byWeek": {
        "moneyline": group_summary(settled, week_of),
        "spread": group_summary(spread_rows, week_of, "spreadPick"),
        "totals": group_summary(total_rows, week_of, "totalPick")
    },
    "byModelVersion": {
        "moneyline": group_summary(settled, version_of),
        "spread": group_summary(spread_rows, version_of, "spreadPick"),
        "totals": group_summary(total_rows, version_of, "totalPick")
    },
    "spreadByProbability": group_summary(spread_rows, lambda r: probability_band(r, "spreadPick"), "spreadPick"),
    "spreadByEV": group_summary(spread_rows, lambda r: ev_band(r, "spreadPick"), "spreadPick"),
    "totalsByProbability": group_summary(total_rows, lambda r: probability_band(r, "totalPick"), "totalPick"),
    "totalsByEV": group_summary(total_rows, lambda r: ev_band(r, "totalPick"), "totalPick"),
    "dataQuality": {
        "officialMissingModelVersion": sum(1 for r in official if not r.get("modelVersion")),
        "officialMissingLockedAt": sum(1 for r in official if not r.get("lockedAt")),
        "officialMissingFinalAt": sum(1 for r in official if not r.get("finalAt")),
        "settledMissingSpreadResult": sum(1 for r in settled if r.get("spreadPick") and (r["spreadPick"].get("result") not in ("win", "loss", "push"))),
        "settledMissingTotalResult": sum(1 for r in settled if r.get("totalPick") and (r["totalPick"].get("result") not in ("win", "loss", "push"))),
        "settledMissingProjection": sum(1 for r in settled if not isinstance(r.get("projectedMargin"), (int, float)) or not isinstance(r.get("projectedTotal"), (int, float)))
    },
    "limitations": [
        "Only immutable official predictions are included; draft predictions are excluded.",
        "Historical picks are evaluated as stored; no external prediction source is substituted.",
        "ROI is computed only where a valid decimal price was stored; it is not inferred where odds are missing.",
        "Aggregates are diagnostic and do not establish causality or guarantee future performance."
    ]
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("NBA_EDGE_PRIVATE_LEDGER_AUDIT " + json.dumps(report, ensure_ascii=False))
