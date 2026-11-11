import asyncio, json
from pathlib import Path
from playwright.async_api import async_playwright

URL = "https://bookmakers.market/basketball/usa/nba/odds/"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="en-US", timezone_id="Asia/Taipei")
        requests_seen, responses_seen = [], []
        page.on("request", lambda r: requests_seen.append({"url": r.url, "method": r.method, "type": r.resource_type}))
        async def on_response(r):
            item = {"url": r.url, "status": r.status, "type": r.request.resource_type}
            try:
                headers = await r.all_headers()
                if "json" in headers.get("content-type", "").lower():
                    item["json_preview"] = (await r.text())[:10000]
            except Exception:
                pass
            responses_seen.append(item)
        page.on("response", on_response)
        try:
            response = await page.goto(URL, wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(7000)
            body = await page.locator("body").inner_text(timeout=15000)
            required = ["moneyline", "spread", "total", "over", "under"]
            lower = body.lower()
            checks = {k: k in lower for k in required}
            lines = [x.strip() for x in body.splitlines() if x.strip()]
            table_lines = [x for x in lines if any(k in x.lower() for k in ["knicks", "bucks", "celtics", "76ers", "phoenix", "clippers", "220.5", "217.5"])]
            result = {
                "status": response.status if response else None,
                "final_url": page.url,
                "title": await page.title(),
                "checks": checks,
                "table_excerpt": table_lines[:100],
                "requests": requests_seen,
                "responses": responses_seen,
                "body_preview": body[:18000]
            }
            Path("bookmakers-nba-odds-inspection.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print("HTTP_STATUS", result["status"])
            print("FINAL_URL", result["final_url"])
            print("TITLE", result["title"])
            print("MARKET_CHECKS", json.dumps(checks))
            print("ODDS_LINES_BEGIN")
            print("\\n".join(table_lines[:100]))
            print("ODDS_LINES_END")
            print("JSON_RESPONSES")
            for item in responses_seen:
                if "json_preview" in item:
                    print(json.dumps(item, ensure_ascii=False)[:12000])
            if not (response and response.status == 200 and all(checks.values()) and table_lines):
                raise SystemExit("Bookmakers Market page did not pass live market content validation.")
        finally:
            await browser.close()

asyncio.run(main())
