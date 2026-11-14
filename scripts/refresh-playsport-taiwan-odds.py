import asyncio
import datetime as dt
import json
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

from playwright.async_api import async_playwright

TAIPEI = ZoneInfo("Asia/Taipei")
BASE = "https://www.playsport.cc/predict/games?allianceid=3&from=header&type=p"
SOURCE = 'Taiwan Sports Lottery odds via PlaySport "運彩盤" column (third-party display)'
BOOK = '台灣運彩（玩運彩「運彩盤」欄位；第三方資料呈現）'

TEAM_ALIASES = {
    "老鷹":"ATL", "塞爾提克":"BOS", "塞爾提":"BOS", "籃網":"BKN", "黃蜂":"CHA",
    "公牛":"CHI", "騎士":"CLE", "獨行俠":"DAL", "金塊":"DEN", "活塞":"DET",
    "勇士":"GSW", "火箭":"HOU", "溜馬":"IND", "快艇":"LAC", "湖人":"LAL",
    "灰熊":"MEM", "熱火":"MIA", "公鹿":"MIL", "灰狼":"MIN", "鵜鶘":"NOP",
    "尼克":"NYK", "雷霆":"OKC", "魔術":"ORL", "76人":"PHI", "太陽":"PHX",
    "拓荒者":"POR", "國王":"SAC", "馬刺":"SAS", "暴龍":"TOR", "爵士":"UTA", "巫師":"WAS"
}
ESPN_ALIASES = {"NYK":"NY", "UTA":"UTAH", "WAS":"WSH", "NOP":"NO", "GSW":"GS", "SAS":"SA"}

def fetch_espn_games(target_date):
    import urllib.request
    result = {}
    for offset in (-1, 0, 1):
        us_date = (target_date + dt.timedelta(days=offset)).strftime("%Y%m%d")
        url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={us_date}"
        req = urllib.request.Request(url, headers={"User-Agent":"NBA-EDGE/1.0","Accept":"application/json"})
        with urllib.request.urlopen(req, timeout=25) as response:
            payload = json.load(response)
        for event in payload.get("events", []):
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
            try:
                start = dt.datetime.fromisoformat(event["date"].replace("Z","+00:00"))
                if start.astimezone(TAIPEI).date() != target_date:
                    continue
            except Exception:
                continue
            event_row = {
                "id":str(event.get("id") or ""),
                "commence_time":event.get("date"),
                "home_team":hteam.get("name") or hteam.get("displayName"),
                "away_team":ateam.get("name") or ateam.get("displayName")
            }
            result[(aabbr, habbr)] = event_row
            result[(ESPN_ALIASES.get(aabbr, aabbr), ESPN_ALIASES.get(habbr, habbr))] = event_row
    return result

def numeric_line(lines, pattern):
    for line in lines:
        match = re.match(pattern, line, re.I)
        if match:
            try:
                return tuple(float(value) for value in match.groups())
            except (TypeError, ValueError):
                return None
    return None

def parse_side(lines, side):
    spread = numeric_line(lines, rf"^{side}\s*([+-]?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$")
    moneyline = numeric_line(lines, rf"^{side}\s*,?\s*(\d+(?:\.\d+)?)$")
    over = numeric_line(lines, r"^大\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$")
    under = numeric_line(lines, r"^小\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$")
    return {"spread":spread, "moneyline":moneyline, "over":over, "under":under}

def extract_game_blocks(lines):
    starts = []
    for index, line in enumerate(lines[:-1]):
        if re.fullmatch(r"\d{3,4}", line) and re.match(r"^(AM|PM)\s+\d{1,2}:\d{2}$", lines[index+1], re.I):
            starts.append(index)
    for position, start in enumerate(starts):
        end = starts[position+1] if position+1 < len(starts) else len(lines)
        yield lines[start:end]

def parse_blocks(body, espn_games):
    lines = [re.sub(r"\s+", " ", line).strip() for line in body.splitlines()]
    lines = [line for line in lines if line]
    games, unmatched = [], []
    for block in extract_game_blocks(lines):
        labels = [(i, line, TEAM_ALIASES[line]) for i, line in enumerate(block) if line in TEAM_ALIASES]
        if len(labels) < 2:
            continue
        away_index, away_label, away_abbr = labels[0]
        home_index, home_label, home_abbr = labels[1]
        event = espn_games.get((away_abbr, home_abbr)) or espn_games.get((ESPN_ALIASES.get(away_abbr, away_abbr), ESPN_ALIASES.get(home_abbr, home_abbr)))
        if not event:
            unmatched.append(f"{away_label}@{home_label}")
            continue
        away_markets = parse_side(block[away_index+1:home_index], "客")
        home_markets = parse_side(block[home_index+1:], "主")
        markets = []
        if away_markets["spread"] and home_markets["spread"]:
            markets.append({"key":"spreads","outcomes":[
                {"name":event["away_team"],"point":away_markets["spread"][0],"price":away_markets["spread"][1]},
                {"name":event["home_team"],"point":home_markets["spread"][0],"price":home_markets["spread"][1]}
            ]})
        if away_markets["moneyline"] and home_markets["moneyline"]:
            markets.append({"key":"h2h","outcomes":[
                {"name":event["away_team"],"price":away_markets["moneyline"][0]},
                {"name":event["home_team"],"price":home_markets["moneyline"][0]}
            ]})
        if away_markets["over"] and home_markets["under"]:
            markets.append({"key":"totals","outcomes":[
                {"name":"Over","point":away_markets["over"][0],"price":away_markets["over"][1]},
                {"name":"Under","point":home_markets["under"][0],"price":home_markets["under"][1]}
            ]})
        if markets:
            games.append({
                "id":event["id"],"commence_time":event["commence_time"],
                "home_team":event["home_team"],"away_team":event["away_team"],
                "bookmakers":[{"title":BOOK,"markets":markets}]
            })
    return games, unmatched

async def read_page(target_date):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="zh-TW",timezone_id="Asia/Taipei",
            viewport={"width":1440,"height":1200},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
        response = await page.goto(BASE,wait_until="domcontentloaded",timeout=45000)
        try:
            await page.wait_for_load_state("networkidle",timeout=10000)
        except Exception:
            pass
        await page.wait_for_timeout(1200)
        body = await page.locator("body").inner_text(timeout=15000)
        title = await page.title()
        await browser.close()
    if not response or response.status != 200:
        raise RuntimeError(f"PlaySport prediction page HTTP {response.status if response else 'no response'}")
    if "運彩盤" not in body or "不讓分" not in body:
        raise RuntimeError("PlaySport page does not expose the expected separate 運彩盤 columns.")
    return title, body

async def main():
    if __import__("os").environ.get("SPORTSLOTTERY_FEED_URL", "").strip():
        print("Authorized official feed is configured; skipping PlaySport fallback.")
        return
    now = dt.datetime.now(TAIPEI)
    target_text = (__import__("os").environ.get("TARGET_TAIWAN_DATE","").strip()
        or (now.date()+dt.timedelta(days=1)).strftime("%Y%m%d"))
    target_date = dt.datetime.strptime(target_text,"%Y%m%d").date()
    title, body = await read_page(target_date)
    espn_games = fetch_espn_games(target_date)
    games, unmatched = parse_blocks(body,espn_games)
    if not games:
        raise SystemExit(f"No verified Taiwan odds rows matched ESPN for {target_text}; keeping prior odds untouched.")
    result = {
        "updatedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
        "targetTaiwanDate":target_text,"pageTitle":title,"source":SOURCE,
        "games":games,"unmatched":unmatched
    }
    print("PLAYSPORT_TAIWAN_HEALTH",json.dumps({
        "targetDate":target_text,
        "games":len(games),
        "unmatchedCount":len(unmatched),
        "marketCounts":{key:sum(any(m["key"]==key for b in g["bookmakers"] for m in b["markets"]) for g in games) for key in ("h2h","spreads","totals")}
    },ensure_ascii=False))
    if "--dry-run" in sys.argv:
        Path("playsport-taiwan-dryrun.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
        return

    root = Path("public/data")
    odds_path, history_path = root/"odds.json", root/"odds-history.jsonl"
    previous = {}
    try:
        old = json.loads(odds_path.read_text(encoding="utf-8"))
        for game in old.get("games",[]):
            if game.get("id"):
                previous[str(game["id"])] = game
    except Exception:
        pass
    seen = set()
    if history_path.exists():
        for line in history_path.read_text(encoding="utf-8").splitlines():
            try: seen.add(str(json.loads(line).get("gameId")))
            except Exception: pass
    snapshots=[]
    for game in games:
        old=previous.get(str(game["id"]),{})
        other_books=[b for b in old.get("bookmakers",[]) if "玩運彩" not in str(b.get("title","")) and "OddsLab" not in str(b.get("title",""))]
        game["bookmakers"]=other_books+game["bookmakers"]
        previous[str(game["id"])]=game
        start=dt.datetime.fromisoformat(game["commence_time"].replace("Z","+00:00"))
        phase="first_observed" if str(game["id"]) not in seen else ("live" if start<=dt.datetime.now(dt.timezone.utc) else "pregame")
        snapshots.append({"capturedAt":dt.datetime.now(dt.timezone.utc).isoformat(),"phase":phase,
            "source":SOURCE,"gameId":game["id"],"home_team":game["home_team"],"away_team":game["away_team"],
            "commence_time":game["commence_time"],"bookmakers":game["bookmakers"][-1:]})
    root.mkdir(parents=True,exist_ok=True)
    ordered=sorted(previous.values(),key=lambda g:g.get("commence_time",""))
    odds_path.write_text(json.dumps({"updatedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
        "source":SOURCE,"games":ordered},ensure_ascii=False,separators=(",",":")),encoding="utf-8")
    with history_path.open("a",encoding="utf-8") as f:
        for snapshot in snapshots:
            f.write(json.dumps(snapshot,ensure_ascii=False,separators=(",",":"))+"\n")
    print(f"Saved {len(games)} PlaySport Taiwan Sports Lottery games and {len(snapshots)} snapshots.")

if __name__ == "__main__":
    asyncio.run(main())
