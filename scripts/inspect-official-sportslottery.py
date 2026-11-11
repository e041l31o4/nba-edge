import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

URL = "https://www.sportslottery.com.tw/sportsbook/daily-coupons"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(
            locale="zh-TW",
            timezone_id="Asia/Taipei",
            viewport={"width": 1440, "height": 1100},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        )
        response = None
        try:
            response = await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            try:
                await page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            await page.wait_for_timeout(5000)
            status = response.status if response else "no-response"
            print(f"HTTP_STATUS={status}")
            print(f"FINAL_URL={page.url}")
            print(f"PAGE_TITLE={await page.title()}")
            text = await page.locator("body").inner_text(timeout=15000)
            print("===== BODY_TEXT_BEGIN =====")
            print(text[:30000])
            print("===== BODY_TEXT_END =====")
            links = await page.locator("a").evaluate_all("(els) => els.map(a => ({text:(a.innerText||'').trim(), href:a.href})).filter(x => x.text || x.href).slice(0,150)")
            print("===== LINKS_BEGIN =====")
            for item in links:
                print(f"{item['text']}\t{item['href']}")
            print("===== LINKS_END =====")
            frames = await page.locator("iframe").evaluate_all("(els) => els.map(x => x.src)")
            print("IFRAMES=" + repr(frames))
            await page.screenshot(path="sportslottery-probe.png", full_page=True)
            Path("sportslottery-probe.html").write_text(await page.content(), encoding="utf-8")
            if status != 200:
                raise SystemExit(f"Official page returned HTTP {status}; no odds were extracted.")
        finally:
            await browser.close()

asyncio.run(main())
