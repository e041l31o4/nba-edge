import asyncio
import datetime as dt
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

TAIPEI = dt.timezone(dt.timedelta(hours=8))
today = dt.datetime.now(TAIPEI).date()
target = (__import__("os").environ.get("TARGET_TAIWAN_DATE", "").strip() or (today + dt.timedelta(days=1)).strftime("%Y%m%d"))
pretty = f"{target[4:6]}/{target[6:8]}"
urls = [
    f"https://www.playsport.cc/livescore/3?gamedate={target}&mode=1",
    f"https://www.playsport.cc/livescore/3?gamedate={target}&mode=2",
    f"https://www.playsport.cc/predict/games?allianceid=3&from=header&type=p&gamedate={target}",
    "https://www.playsport.cc/predict/games?allianceid=3&from=header&type=p",
]

async def main():
    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="zh-TW", timezone_id="Asia/Taipei",
            viewport={"width":1440,"height":1200},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
        for url in urls:
            requests_seen, responses_seen = [], []
            page.on("request", lambda req, bucket=requests_seen: bucket.append({"method":req.method,"url":req.url,"type":req.resource_type}))
            page.on("response", lambda res, bucket=responses_seen: bucket.append({"status":res.status,"url":res.url}))
            row = {"requestedUrl":url}
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
                try: await page.wait_for_load_state("networkidle", timeout=9000)
                except Exception: pass
                await page.wait_for_timeout(1200)
                body = await page.locator("body").inner_text(timeout=12000)
                row.update({
                    "status":response.status if response else None, "finalUrl":page.url,
                    "title":await page.title(), "targetDateVisible":pretty in body or target in body,
                    "hasTaiwanOddsLabel":"運彩盤" in body or "台灣運彩" in body,
                    "hasInternationalLabel":"國際盤" in body or "國際運彩" in body,
                    "bodyExcerpt":body[:16000],
                    "scripts":await page.locator("script[src]").evaluate_all("(els)=>els.map(x=>x.src).filter(x=>x.includes('playsport.cc'))"),
                    "links":await page.locator("a").evaluate_all("(els)=>els.map(a=>({text:(a.innerText||'').trim(),href:a.href})).filter(x=>/運彩|國際|11\\/14|11\\/13/.test(x.text+' '+x.href)).slice(0,80)"),
                    "requests":requests_seen[-100:],"responses":responses_seen[-100:]
                })
                row["marketLines"] = [line.strip() for line in body.splitlines() if "運彩" in line or "國際" in line or re.search(r"(客|主)\s*[+-]?\s*\d+(?:\.\d+)?\s*,\s*\d+\.\d+", line) or re.search(r"(大|小)\s*\d+(?:\.\d+)?\s*,\s*\d+\.\d+", line)][:100]
                row["modeControls"] = await page.locator("a,button,select,option,li,span").evaluate_all("""els => els.filter(el => el.children.length < 3 && ['運彩','國際'].includes((el.innerText||'').trim())).map(el => ({tag:el.tagName,text:(el.innerText||'').trim(),href:el.href||'',className:String(el.className||''),html:el.outerHTML.slice(0,500)})).slice(0,40)""")
                marker=body.find("運彩盤")
                if marker>=0: row["taiwanMarketExcerpt"]=body[max(0,marker-1200):marker+9000]
            except Exception as exc:
                row["error"]=f"{type(exc).__name__}: {exc}"
                row["requests"]=requests_seen[-100:]; row["responses"]=responses_seen[-100:]
            results.append(row)
            print("PLAYSPORT_PROBE",json.dumps({"url":url,"status":row.get("status"),"finalUrl":row.get("finalUrl"),
                "targetDate":target,"dateVisible":row.get("targetDateVisible"),"taiwanLabel":row.get("hasTaiwanOddsLabel"),
                "internationalLabel":row.get("hasInternationalLabel"),"marketLines":row.get("marketLines",[])[:30],
                "modeControls":row.get("modeControls",[])[:20],"error":row.get("error")},ensure_ascii=False))
            await page.wait_for_timeout(900)
        await browser.close()
    Path("playsport-taiwan-probe.json").write_text(json.dumps({"targetTaiwanDate":target,
        "capturedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
        "source":"PlaySport public pages; diagnostic only, no odds imported","results":results},
        ensure_ascii=False,indent=2),encoding="utf-8")
    if not any(x.get("status")==200 and x.get("targetDateVisible") and x.get("hasTaiwanOddsLabel") for x in results):
        raise SystemExit("No verified PlaySport Taiwan Sports Lottery market page found; no odds were imported.")

asyncio.run(main())
