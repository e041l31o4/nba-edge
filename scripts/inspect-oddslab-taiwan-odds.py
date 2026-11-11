import asyncio, json, re\nfrom datetime import datetime\nfrom zoneinfo import ZoneInfo
from pathlib import Path
from playwright.async_api import async_playwright

TAIPEI_DATE = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d")\nURL = f"https://oddslab-taiwan.com/games?date={TAIPEI_DATE}"
REQUIRED_TEAMS = ["公鹿", "尼克", "塞爾提克", "76人", "快艇", "太陽", "熱火", "爵士", "魔術", "國王", "雷霆", "拓荒者"]

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="zh-TW", timezone_id="Asia/Taipei")
        response = await page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3500)
        body = await page.locator("body").inner_text(timeout=15000)
        html = await page.content()
        lines = [x.strip() for x in body.splitlines() if x.strip()]
        checks = {
            "http_200": bool(response and response.status == 200),
            "taiwan_odds_context": "運彩" in body and ("台灣" in body or "運彩" in body),
            "moneyline": "不讓分" in body,
            "spread": "讓分" in body,
            "totals": "大小" in body,
            "all_12_team_names": all(x in body for x in REQUIRED_TEAMS),
            "odds_values": len(re.findall(r"(?<!\\d)\\d+\\.\\d{2}(?!\\d)", body)) >= 12,
            "updated_timestamp": bool(re.search(r"更新.{0,12}\\d{1,2}/\\d{1,2}\\s+\\d{1,2}:\\d{2}", body))
        }
        result = {
            "status": response.status if response else None,
            "final_url": page.url,
            "title": await page.title(),
            "checks": checks,
            "body_lines": lines[:180],
            "body_preview": body[:24000],
            "html_preview": html[:12000]
        }
        Path("oddslab-taiwan-odds-inspection.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print("HTTP_STATUS", result["status"])
        print("TITLE", result["title"])
        print("VALIDATION", json.dumps(checks, ensure_ascii=False))
        print("PAGE_LINES_BEGIN")
        print("\\n".join(lines[:180]))
        print("PAGE_LINES_END")
        await browser.close()
        if not all(checks.values()):
            raise SystemExit("OddsLab public Taiwan Sports Lottery page failed validation; no odds will be published.")

asyncio.run(main())
