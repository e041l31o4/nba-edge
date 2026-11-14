import asyncio
import datetime as dt
import json
import re
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

from playwright.async_api import async_playwright

ROOT = Path("public/data")
SOURCE = "OddsLab Taiwan Sports Lottery public odds page (third-party republication)"
BOOK = "台灣運彩（OddsLab 公開整理，非官方 API）"
TAIPEI = ZoneInfo("Asia/Taipei")
TEAM_LABELS = ["公鹿", "尼克", "塞爾提克", "76人", "快艇", "太陽", "熱火", "爵士", "魔術", "國王", "雷霆", "拓荒者"]

def fetch_espn_games(taipei_date: dt.date):
    # The source page uses Taiwan calendar dates; ESPN indexes games by US event date.
    # Query adjacent US dates and match by both team abbreviations, not by date alone.
    result = {}
    for offset in (-1, 0, 1):
        us_date = (taipei_date + dt.timedelta(days=offset)).strftime("%Y%m%d")
        url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={us_date}"
        req = urllib.request.Request(url, headers={"User-Agent": "NBA-EDGE/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as response:
            data = json.load(response)
        for event in data.get("events", []):
            comp = (event.get("competitions") or [{}])[0]
            competitors = comp.get("competitors") or []
            home = next((x for x in competitors if x.get("homeAway") == "home"), None)
            away = next((x for x in competitors if x.get("homeAway") == "away"), None)
            if not home or not away:
                continue
            hteam, ateam = home.get("team") or {}, away.get("team") or {}
            habbr, aabbr = hteam.get("abbreviation"), ateam.get("abbreviation")
            if not habbr or not aabbr:
                continue
            result[(aabbr, habbr)] = {
                "id": str(event.get("id") or ""),
                "commence_time": event.get("date"),
                "home_team": hteam.get("name") or hteam.get("displayName"),
                "away_team": ateam.get("name") or ateam.get("displayName"),
            }
    return result

async def scrape_page(date_text: str):
    url = f"https://oddslab-taiwan.com/games?date={date_text}"
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="zh-TW", timezone_id="Asia/Taipei")
        response = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(2500)
        if not response or response.status != 200:
            raise RuntimeError(f"OddsLab HTTP status: {response.status if response else 'no response'}")
        body = await page.locator("body").inner_text(timeout=15000)
        cards = await page.locator("a.card").evaluate_all("""cards => cards.map(card => {
          const rows = [...(card.querySelector("div.space-y-1\\\\.5")?.children || [])];
          const teams = rows.map(row => ({
            abbreviation: row.querySelector(".figure-text")?.innerText?.trim() || "",
            name: row.querySelector("[title]")?.innerText?.trim() || "",
            fullName: row.querySelector("[title]")?.getAttribute("title") || ""
          })).filter(x => x.abbreviation && x.name);
          const markets = {};
          for (const block of card.querySelectorAll("div.flex.items-start.gap-3")) {
            const label = block.querySelector("span.w-12")?.innerText?.trim() || "";
            const key = label.includes("不讓分") ? "h2h" : label.includes("讓分") ? "spreads" : label.includes("大小") ? "totals" : "";
            if (!key) continue;
            markets[key] = [...block.querySelectorAll("span.flex.min-w-0.items-baseline.justify-between")].map(option => ({
              outcome: option.querySelector("span.truncate")?.innerText?.trim() || "",
              priceText: option.querySelector(".figure-text")?.innerText?.trim() || ""
            })).filter(x => x.outcome);
          }
          return { id: (card.getAttribute("href") || "").split("/").pop() || "", teams, markets };
        })""")
        await browser.close()
    if "運彩" not in body:
        raise RuntimeError("OddsLab page did not contain the expected public Taiwan lottery page.")
    # A valid page with zero cards means the date has no published odds yet.
    updated = re.search(r"賠率更新\s*(\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2})", body)
    return cards, updated.group(1) if updated else None

def valid_price(value):
    try:
        price = float(value)
        return price if price > 1 and price < 100 else None
    except (TypeError, ValueError):
        return None

def parse_market_options(card, key, away_name, home_name, away_label, home_label):
    raw = card.get("markets", {}).get(key, [])
    out = []
    for option in raw:
        label = option.get("outcome", "").strip()
        price = valid_price(option.get("priceText"))
        if not price:
            continue
        if key == "h2h":
            if label == away_label:
                name = away_name
            elif label == home_label:
                name = home_name
            else:
                continue
            out.append({"name": name, "price": price})
        elif key == "spreads":
            m = re.match(r"^(.*?)\s*([+＋−-])\s*(\d+(?:\.\d+)?)$", label)
            if not m:
                continue
            team_label, sign, number = m.groups()
            if team_label.strip() == away_label:
                name = away_name
            elif team_label.strip() == home_label:
                name = home_name
            else:
                continue
            point = float(number) * (-1 if sign in ("−", "-") else 1)
            out.append({"name": name, "price": price, "point": point})
        elif key == "totals":
            m = re.match(r"^(大|小)\s*(\d+(?:\.\d+)?)$", label)
            if not m:
                continue
            side, number = m.groups()
            out.append({"name": "Over" if side == "大" else "Under", "price": price, "point": float(number)})
    return out if len(out) == 2 else []

async def main():
    if __import__("os").environ.get("SPORTSLOTTERY_FEED_URL", "").strip():
        print("Official Taiwan Sports Lottery feed configured; third-party fallback skipped.")
        return
    today = dt.datetime.now(TAIPEI).date()
    # Poll a rolling 7-day Taiwan calendar window so pregame odds are captured
    # as soon as published. No odds are fabricated for games not yet opened.
    all_games = {}
    snapshots = []
    unmatched = []
    now = dt.datetime.now(dt.timezone.utc)
    for offset in range(7):
        taiwan_day = today + dt.timedelta(days=offset)
        date_text = taiwan_day.strftime("%Y-%m-%d")
        try:
            cards, source_updated = await scrape_page(date_text)
        except Exception as error:
            print("Odds page unavailable for", date_text, "-", str(error)[:180])
            continue
        if not cards:
            print("No Taiwan Sports Lottery odds published yet for", date_text)
            continue
        espn = fetch_espn_games(taiwan_day)
        for card in cards:
            teams = card.get("teams") or []
            if len(teams) != 2:
                unmatched.append(card.get("id", "unknown"))
                continue
            away, home = teams[0], teams[1]
            espn_alias = {"NYK": "NY", "UTA": "UTAH", "WAS": "WSH", "NOP": "NO", "GSW": "GS", "SAS": "SA"}
            away_code = espn_alias.get(away["abbreviation"], away["abbreviation"])
            home_code = espn_alias.get(home["abbreviation"], home["abbreviation"])
            event = espn.get((away_code, home_code))
            if not event or not event.get("commence_time"):
                unmatched.append(f'{date_text}:{away["abbreviation"]}@{home["abbreviation"]}')
                continue
            markets = []
            for key in ("h2h", "spreads", "totals"):
                options = parse_market_options(card, key, event["away_team"], event["home_team"], away["name"], home["name"])
                if options:
                    markets.append({"key": key, "outcomes": options})
            if not markets:
                continue
            game = {
                "id": event["id"],
                "commence_time": event["commence_time"],
                "home_team": event["home_team"],
                "away_team": event["away_team"],
                "bookmakers": [{"title": BOOK, "markets": markets}],
            }
            all_games[event["id"]] = game
            snapshots.append({
                "capturedAt": now.isoformat(),
                "phase": "live" if dt.datetime.fromisoformat(event["commence_time"].replace("Z", "+00:00")) <= now else "pregame",
                "source": SOURCE,
                "gameId": event["id"],
                "home_team": event["home_team"],
                "away_team": event["away_team"],
                "commence_time": event["commence_time"],
                "bookmakers": game["bookmakers"],
                "sourcePageUpdatedAt": source_updated,
            })
    if unmatched:
        print("Unmatched public odds cards (not imported):", ", ".join(unmatched))
    odds_path = ROOT / "odds.json"
    history_path = ROOT / "odds-history.jsonl"
    previous = {}
    try:
        old = json.loads(odds_path.read_text(encoding="utf-8"))
        for game in old.get('games', []):
            start_time = game.get("commence_time", "")
            if game.get('id') and start_time:
                if dt.datetime.fromisoformat(start_time.replace("Z", "+00:00")) > now:
                    previous[str(game["id"])] = game
    except Exception:
        pass
    # Keep valid future snapshots for dates where the board has not republished.
    previous.update(all_games)
    if not previous:
        print("No published pregame markets found in the rolling 7-day window; retaining the previous odds dataset.")
        return
    ROOT.mkdir(parents=True, exist_ok=True)
    ordered_games = sorted(previous.values(), key=lambda game: game.get("commence_time", ""))
    record = {
        "updatedAt": now.isoformat(),
        "source": SOURCE,
        "windowDays": 7,
        "games": ordered_games,
    }
    odds_path.write_text(json.dumps(record, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if snapshots:
        with history_path.open("a", encoding="utf-8") as f:
            for row in snapshots:
                f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({
        "source": SOURCE,
        "window_days": 7,
        "newly_observed_games": len(all_games),
        "retained_future_games": len(previous),
        "snapshots": len(snapshots),
        "market_counts": {key: sum(any(m["key"] == key for b in (g.get("bookmakers") or []) for m in b.get("markets", [])) for g in ordered_games) for key in ("h2h", "spreads", "totals")},
        "games": [{"away": g["away_team"], "home": g["home_team"], "commence_time": g["commence_time"], "markets": [m["key"] for b in g.get("bookmakers", []) for m in b.get("markets", [])]} for g in ordered_games],
    }, ensure_ascii=False))
if __name__ == "__main__":
    asyncio.run(main())
