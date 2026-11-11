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
                    # Inspect the public runtime API surface without submitting wagers or bypassing access controls.
                    if "sportslottery.com.tw/zh-tw" in page.url or page.url.rstrip("/") == "https://article.sportslottery.com.tw":
                        try:
                            runtime = await page.evaluate("""() => {
                              const a = window.tslc && window.tslc.apidata;
                              if (!a) return {available:false};
                              const out = {available:true, keys:Object.keys(a)};
                              for (const group of ['preGame','liveGame','basketball','ticket']) {
                                if (a[group]) {
                                  out[group] = {};
                                  for (const [k,v] of Object.entries(a[group])) {
                                    if (typeof v === 'function') out[group][k] = String(v).slice(0,5000);
                                  }
                                }
                              }
                              for (const key of ['download','_download','_apiDownload','_blobDownload','restoreJson']) {
                                if (typeof a[key] === 'function') out[key] = String(a[key]).slice(0,9000);
                              }
                              out.state = {
                                blobUrl: a.blobUrl,
                                pos: a.pos,
                                livePos: a.livePos,
                                registerPos: a.registerPos,
                                jsonData: a.jsonData && typeof a.jsonData === 'object' ? Object.fromEntries(Object.entries(a.jsonData).slice(0,30).map(([k,v]) => [k, typeof v === 'function' ? String(v).slice(0,1000) : v])) : a.jsonData,
                                homePage: a.homePage,
                                homePage_nonMember: a.homePage_nonMember,
                                homePage_member: a.homePage_member
                              };
                              const decoder = window._0xbfd83e;
                              out.decoderAvailable = typeof decoder === 'function';
                              if (typeof decoder === 'function') {
                                const pairs = [
                                  [0x49d,'QI5&'],[0x56a,'kN7%'],[0x53c,'Rz]o'],[0x2a2,'qnVd'],[0x419,'Cg(c'],
                                  [0x20d,'qnVd'],[0x2ee,'TQnK'],[0x4ca,'Ii4a'],[0x3f0,'U]iz'],
                                  [0x2d8,'9oI4'],[0x300,'8glf'],[0x206,'8Bln'],[0x59f,'wcFC'],
                                  [0x2f6,'P#kR'],[0x1ce,'2JmO'],[0x1da,'djGT'],[0x597,'cS^8']
                                ];
                                out.decodedPreGame = pairs.map(([n,k]) => [n,k,decoder(n,k)]);
                              }
                              return out;
                            }""")
                            print("RUNTIME_APIDATA=" + repr(runtime))
                        except Exception as runtime_exc:
                            print(f"RUNTIME_APIDATA_ERROR={type(runtime_exc).__name__}: {runtime_exc}")
                    # Probe a small range of public sport IDs; read-only and no access-control bypass.
                    if index == 2:
                        for sport_id in range(1, 13):
                            candidate_url = f"https://blob.sportslottery.com.tw/apidata/Pre/ListBySport/{sport_id}.json"
                            try:
                                candidate = await page.request.get(candidate_url, timeout=10000)
                                candidate_text = await candidate.text()
                                has_nba = "NBA" in candidate_text or "美國職籃" in candidate_text
                                print(f"PREGAME_CANDIDATE sport_id={sport_id} url={candidate_url} status={candidate.status} content_type={candidate.headers.get('content-type')} bytes={len(candidate_text)} has_nba={has_nba}")
                                if candidate.status == 200 and ("json" in (candidate.headers.get("content-type") or "").lower()):
                                    print(f"PREGAME_CANDIDATE_BODY sport_id={sport_id} body={candidate_text[:12000]}")
                            except Exception as candidate_exc:
                                print(f"PREGAME_CANDIDATE_ERROR sport_id={sport_id}: {type(candidate_exc).__name__}: {candidate_exc}")
                    # Inspect only JavaScript already loaded by the official public homepage.
                    # This is passive source inspection; it does not bypass access controls.
                    if "sportslottery.com.tw/zh-tw" in page.url or page.url.rstrip("/") == "https://article.sportslottery.com.tw":
                        for script_url in scripts:
                            if "sportslottery.com.tw" not in script_url:
                                continue
                            # Inspect first-party application bundles from the public official homepage.
                            # Skip common vendor/analytics assets; do not navigate around access controls.
                            lowered_url = script_url.lower()
                            if any(name in lowered_url for name in ("jquery", "bootstrap", "gtag", "analytics", "chat", "recaptcha")):
                                continue
                            try:
                                script_response = await page.request.get(script_url, timeout=15000)
                                if not script_response.ok:
                                    continue
                                script_text = await script_response.text()
                                import re
                                matches = sorted(set(re.findall(r"""[^"'\\s]{0,100}(?:apidata|sportsbook|coupon|odds|basketball)[^"'\\s]{0,160}""", script_text, re.I)))
                                if matches:
                                    print(f"JS_ENDPOINT_CANDIDATES {script_url}=" + repr(matches[:120]))
                                # Print source context around official basketball data methods.
                                for needle in (".getBasketballForm", ".getBasketballLi", "GetBasketballForm", "GetBasketballLi", "PreGame.Basketball", "Basketball/Form", "oddsMode", "getListBySport", "apidata.download", "preGame", "download:function"):
                                    start = 0
                                    shown = 0
                                    while shown < 5:
                                        pos = script_text.lower().find(needle.lower(), start)
                                        if pos < 0:
                                            break
                                        left = max(0, pos - 1800)
                                        right = min(len(script_text), pos + 4200)
                                        print(f"JS_METHOD_CONTEXT {script_url} {needle} @{pos}=" + script_text[left:right])
                                        start = pos + len(needle)
                                        shown += 1
                                # Locate application call sites to identify official sport IDs and arguments.
                                for needle in ("getListBySport(", "preGame.get(", "preGame.getListByLeague(", "apidata.preGame", "Pre/ListByLeague/", "Pre/ListBySport/", "NBA", "sportId"):
                                    start = 0
                                    shown = 0
                                    while shown < 8:
                                        pos = script_text.find(needle, start)
                                        if pos < 0:
                                            break
                                        left = max(0, pos - 1600)
                                        right = min(len(script_text), pos + 2600)
                                        print(f"JS_CALLSITE {script_url} {needle} @{pos}=" + script_text[left:right])
                                        start = pos + len(needle)
                                        shown += 1
                            except Exception as script_exc:
                                print(f"JS_INSPECT_ERROR {script_url}: {type(script_exc).__name__}: {script_exc}")
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
