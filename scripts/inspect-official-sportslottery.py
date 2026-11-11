import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

URLS = [
    "https://www.sportslottery.com.tw/sportsbook/daily-coupons",
    "https://member2.sportslottery.com.tw/sportsbook/daily-coupons",
    "https://article.sportslottery.com.tw/sportsbook/daily-coupons",
    "https://member2.sportslottery.com.tw/zh-tw",
    "https://article.sportslottery.com.tw/",
]

async def main():
    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(
            locale="zh-TW",
            timezone_id="Asia/Taipei",
            viewport={"width": 1440, "height": 1100},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        )
        try:
            for index, url in enumerate(URLS, start=1):
                requests_seen = []
                responses_seen = []
                page.on("request", lambda req, bucket=requests_seen: bucket.append((req.method, req.url, req.resource_type)))
                page.on("response", lambda res, bucket=responses_seen: bucket.append((res.status, res.url)))
                print(f"===== TARGET {index}: {url} =====")
                try:
                    response = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
                    try:
                        await page.wait_for_load_state("networkidle", timeout=10000)
                    except Exception:
                        pass
                    await page.wait_for_timeout(2500)
                    status = response.status if response else "no-response"
                    title = await page.title()
                    body = await page.locator("body").inner_text(timeout=10000)
                    print(f"HTTP_STATUS={status}")
                    print(f"FINAL_URL={page.url}")
                    print(f"PAGE_TITLE={title}")
                    print("BODY_TEXT_BEGIN")
                    print(body[:12000])
                    print("BODY_TEXT_END")
                    links = await page.locator("a").evaluate_all("(els) => els.map(a => ({text:(a.innerText||'').trim(), href:a.href})).filter(x => x.text || x.href).slice(0,100)")
                    for item in links:
                        print(f"LINK\t{item['text']}\t{item['href']}")
                    frames = await page.locator("iframe").evaluate_all("(els) => els.map(x => x.src)")
                    scripts = await page.locator("script[src]").evaluate_all("(els) => els.map(x => x.src)")
                    print("IFRAMES=" + repr(frames))
                    print("SCRIPTS=" + repr(scripts))
                    print("NETWORK_REQUESTS=" + repr(requests_seen[-150:]))
                    print("NETWORK_RESPONSES=" + repr(responses_seen[-150:]))
                    Path(f"sportslottery-probe-{index}.html").write_text(await page.content(), encoding="utf-8")
                    await page.screenshot(path=f"sportslottery-probe-{index}.png", full_page=True)
                    results.append((url, status, title))
                except Exception as exc:
                    print(f"PAGE_ERROR={type(exc).__name__}: {exc}")
                    results.append((url, "error", str(exc)))
            print("===== SUMMARY =====")
            for result in results:
                print(repr(result))
            if not any(item[1] == 200 for item in results):
                raise SystemExit("No official Taiwan Sports Lottery page returned HTTP 200 in this cloud browser. No odds were extracted.")
        finally:
            await browser.close()

asyncio.run(main())
