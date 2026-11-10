import json
import os
import pathlib
import urllib.request

base = os.environ.get("SUPABASE_URL", "").rstrip("/")
service_key = "".join(os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").split())
if not base or not service_key:
    raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
if any(ord(ch) < 33 or ord(ch) > 126 for ch in service_key):
    raise SystemExit("SUPABASE_SERVICE_ROLE_KEY contains invalid characters")

mapping = {
    "odds": "odds.json",
    "odds-history": "odds-history.jsonl",
    "team-form": "team-form.json",
    "injuries": "injuries.json",
    "rosters": "rosters.json",
    "team-metrics": "team-metrics.json",
    "backtest": "backtest.json",
    "prediction-ledger": "prediction-ledger.json",
}

url = base + "/rest/v1/member_datasets?select=dataset_key,payload"
request = urllib.request.Request(
    url,
    headers={
        "apikey": service_key,
        "Authorization": "Bearer " + service_key,
        "Accept": "application/json",
    },
)
with urllib.request.urlopen(request, timeout=45) as response:
    rows = json.load(response)

if not isinstance(rows, list):
    raise SystemExit("Unexpected Supabase response: expected a list")

root = pathlib.Path("public/data")
root.mkdir(parents=True, exist_ok=True)
restored = []
for row in rows:
    key = row.get("dataset_key")
    if key not in mapping:
        continue
    payload = row.get("payload")
    path = root / mapping[key]
    if key == "odds-history":
        if not isinstance(payload, list):
            raise SystemExit("Invalid odds-history payload: expected a list")
        path.write_text(
            "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in payload),
            encoding="utf-8",
        )
    else:
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    restored.append(key)

if restored:
    print("Restored private datasets from Supabase: " + ", ".join(sorted(restored)))
else:
    print("No private datasets found in Supabase yet; workflow will continue with generated data.")
