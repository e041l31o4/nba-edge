# NBA EDGE

NBA 賽前數據分析平台（繁體中文 / 台灣時區）。

## 目前版本
- NBA 賽程與賽果：ESPN 公開 scoreboard feed（非官方介面，可能調整）。
- 讓分與大小分：只有設定 The Odds API 金鑰後才顯示真實盤口；未設定時明確標示「尚無盤口資料」，不產生虛構賠率。
- 分析模型：以可取得的球隊近期得失分、主客場與賽程資訊建立初始估計；不是已驗證的最佳權重或保證命中率。
- 歷史績效：僅統計已保存且有真實盤口的預測；樣本不足時不宣稱命中率。

## 開發
```bash
npm install
npm run dev
```

## GitHub Pages
在 Settings → Pages 選擇 GitHub Actions。此專案含 Vite build workflow。

## 可選環境變數
- `VITE_ODDS_API_KEY`：The Odds API key（可在本機 .env.local 使用；勿提交金鑰）。
- GitHub Actions secret `ODDS_API_KEY`：供每日資料更新工作流程使用。

## 資料限制
免費資料來源可用性、欄位與更新頻率可能變動。缺少傷兵、盤口或統計欄位時會標示未取得，不會以假資料補齊。