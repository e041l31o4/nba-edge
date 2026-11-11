import json
import os
import pathlib
import urllib.request

base = os.environ.get("SUPABASE_URL", "").rstrip("/")
service_key = "".join(os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").split())
if not base or not service_key:
    raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
if any(ord(ch) < 33 or ord(ch) > 126 for ch in service_key):
    raise SystemExit("SUPABASE_SERVICE_ROLE_KEY contains invalid characters; re-copy the key from Supabase API Keys without quotes.")

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

rows = []
only_keys = {key.strip() for key in os.environ.get("DATASET_KEYS", "").split(",") if key.strip()}
for key, filename in mapping.items():
    if only_keys and key not in only_keys:
        continue
    path = pathlib.Path("public/data") / filename
    if not path.exists():
        print(f"Skipping missing dataset: {filename}")
        continue
    raw = path.read_text(encoding="utf-8")
    if filename.endswith(".jsonl"):
        payload = [json.loads(line) for line in raw.splitlines() if line.strip()]
    else:
        payload = json.loads(raw)
    rows.append({"dataset_key": key, "payload": payload})

if not rows:
    raise SystemExit("No datasets found to publish")

url = base + "/rest/v1/member_datasets?on_conflict=dataset_key"
body = json.dumps(rows, ensure_ascii=False).encode("utf-8")
request = urllib.request.Request(
    url,
    data=body,
    method="POST",
    headers={
        "apikey": service_key,
        "Authorization": "Bearer " + service_key,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    },
)
with urllib.request.urlopen(request, timeout=45) as response:
    if response.status not in (200, 201, 204):
        raise SystemExit(f"Supabase publish failed: HTTP {response.status}")
print("Published private datasets: " + ", ".join(row["dataset_key"] for row in rows))
