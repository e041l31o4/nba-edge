# NBA EDGE

NBA 賽前數據分析平台（繁體中文 / 台灣時區 UTC+8）。

## 已建立功能
- NBA 每日賽程、比賽狀態、比分與日期切換。
- 賽事分析頁面，分開呈現讓分盤與大小分盤。
- The Odds API 盤口資料檔讀取；沒有資料時明確標示，不製造假盤。
- 模型績效頁先以空白樣本呈現，不虛構命中率或 ROI。
- GitHub Actions 自動建置 GitHub Pages。
- 每 3 小時排程更新盤口資料（需設定 API Secret）。

## 本機開發
```bash
npm install
npm run dev
npm run build
```

## 部署網站
1. 開啟 Repository → Settings → Pages。
2. Build and deployment 的 Source 選擇 **GitHub Actions**。
3. 到 Settings → Secrets and variables → Actions → New repository secret。
4. 建立名稱為 `ODDS_API_KEY` 的 Secret，填入 The Odds API 金鑰。
5. 到 Actions 手動執行 **Build and deploy NBA EDGE**，或推送新 commit 觸發部署。

未設定 `ODDS_API_KEY` 時，網站仍可讀取賽程與比分，但不會顯示虛構盤口。API 金鑰請只放在 GitHub Secret，不要貼在公開程式碼或對話中。

## 資料來源與限制
- 賽程比分：ESPN 公開 JSON 介面。這是非官方、未文件化介面，可能變動，沒有服務保證。
- 讓分與大小分：The Odds API；免費方案的額度、更新頻率與可用欄位依供應商當下方案為準。
- 傷兵、近期效率、輪休與預測模型：後續階段再接入可驗證資料來源。資料未齊全時不輸出投注推薦。
- 模型機率不是實際命中率；歷史績效只會在有保存預測、真實盤口與賽果結算後計算。

## 風險聲明
本專案為運動數據研究與資訊整理工具，不構成投注建議，不保證預測結果。請理性評估風險。