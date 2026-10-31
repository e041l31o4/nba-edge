# NBA EDGE

NBA 專業賽前數據研究平台（繁體中文／台灣時間 UTC+8）。

## 功能
- NBA 賽程、比分、日期切換與賽前分析。
- 台灣運彩官方盤口資料適配器：只接受官方授權、文件化的 JSON feed；不會將其他莊家資料標示成台灣運彩。
- 15 分鐘排程（需先取得官方授權 feed URL）；保留盤口快照供開盤觀測、盤中更新及賽前最後盤回溯。
- 串關研究：2–6 關組合比較、組合賠率、估計過關率、理論 EV 與模擬返還。
- 賽後逐項驗證：命中／未中／走盤；資料保存在目前瀏覽器。
- 模型績效頁不虛構歷史命中率或 ROI。

## 本機開發
```bash
npm install
npm run dev
npm run build
```

## GitHub Pages 部署
Repository → Settings → Pages → Source 選擇 **GitHub Actions**。推送 commit 或在 Actions 手動執行 Build and deploy NBA EDGE。

## 台灣運彩官方資料來源
官方網站提供 NBA 賽事資訊與玩法說明，但目前本專案尚未確認有可公開依賴的官方即時盤口 API。官方玩法及賽事資訊：
- https://www.sportslottery.com.tw/
- https://member2.sportslottery.com.tw/zh-tw/about-us/135

因此目前採用「授權 feed adapter」設計，不抓取登入後資料、不繞過驗證、不把非官方盤口混入官方資料。若台灣運彩或合法資料供應方提供正式 API／資料授權，請在 Repository → Settings → Secrets and variables → Actions 設定：
- `SPORTSLOTTERY_FEED_URL`：官方授權 JSON feed URL
- `SPORTSLOTTERY_API_TOKEN`：若供應方要求，填入 API token

Feed 預期回傳 JSON object，內含 `games` 陣列；每場至少包含 `home_team`、`away_team`、`commence_time`，盤口採標準化 `bookmakers[].markets[].outcomes[]` 格式，market key 使用 `spreads` 與 `totals`。未設定 feed 時，15 分鐘工作流程會安全略過，不會假裝已同步。

### 開盤／即時／賽前定義
- 首次觀測盤：NBA EDGE 第一次成功取得的官方快照；不冒稱官方真正開盤。
- 即時盤：比賽開始後取得的官方快照（若官方 feed 提供場中盤）。
- 賽前盤：開賽前最後一筆官方快照。
- 若 feed 沒有提供真正開盤時間或完整歷史，網站不會回填猜測；歷史從正式接通後開始累積。

## 串關模型與驗證
- 支援 2–6 關組合，顯示組合賠率、估計過關率、理論 EV。
- 目前過關率以各關輸入機率相乘，假設選項獨立；同場相關選項會使估算失真。
- 建議先以 2 關做風險比較，不把多關高賠率誤認為高價值。
- 賽後可標記命中、未中、走盤；目前紀錄存在瀏覽器 localStorage，換裝置或清除瀏覽器資料不會同步。
- 只有累積足夠、可追溯的預測機率、盤口與正式賽果後，才應計算模型命中率與 ROI。

## 風險聲明
NBA EDGE 是運動數據研究與賽事分析工具，不提供保證獲利的投注建議。機率估計、EV 與串關結果均受模型校準、盤口變化、相關性及賽事資訊影響。
