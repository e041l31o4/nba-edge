import asyncio, json, re
from pathlib import Path
from playwright.async_api import async_playwright

URL = "https://www.covers.com/sport/basketball/nba/odds"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="en-US", timezone_id="America/New_York")
        requests_seen, responses_seen = [], []
        page.on("request", lambda r: requests_seen.append({"method": r.method, "url": r.url, "type": r.resource_type}))
        async def on_response(r):
            item = {"status": r.status, "url": r.url, "type": r.request.resource_type}
            try:
                ct = (await r.all_headers()).get("content-type", "")
                if "json" in ct.lower():
                    body = await r.text()
                    item["content_type"] = ct
                    item["body_preview"] = body[:12000]
            except Exception:
                pass
            responses_seen.append(item)
        page.on("response", on_response)
        try:
            response = await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_load_state("networkidle", timeout=20000)
            await page.wait_for_timeout(5000)
            body = await page.locator("body").inner_text(timeout=15000)
            lines = body.splitlines()
            keys = ("Last updated", "Moneyline Odds Table", "Spread Odds Table", "Spread/Total Odds Table", "Nov 11", "Nov 12")
            excerpts = []
            for i, line in enumerate(lines):
                if any(k.lower() in line.lower() for k in keys):
                    excerpts.extend(lines[max(0, i-2):min(len(lines), i+8)])
            Path("covers-nba-odds.html").write_text(await page.content(), encoding="utf-8")
            Path("covers-nba-odds-inspection.json").write_text(json.dumps({
                "status": response.status if response else None,
                "final_url": page.url,
                "title": await page.title(),
                "body_excerpt": excerpts[:500],
                "requests": requests_seen,
                "responses": responses_seen
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print("HTTP_STATUS", response.status if response else None)
            print("FINAL_URL", page.url)
            print("TITLE", await page.title())
            print("ODDS_EXCERPTS_BEGIN")
            print("\\n".join(excerpts[:300]))
            print("ODDS_EXCERPTS_END")
            print("JSON_RESPONSES")
            for r in responses_seen:
                if "body_preview" in r:
                    print(json.dumps(r, ensure_ascii=False)[:14000])
            print("TOTAL_REQUESTS", len(requests_seen), "TOTAL_RESPONSES", len(responses_seen))
            if not any(k in body for k in ("Moneyline Odds Table", "Spread Odds Table", "Spread/Total Odds Table")):
                raise SystemExit("Covers odds tables did not render; do not enable this source.")
        finally:
            await browser.close()

asyncio.run(main())
