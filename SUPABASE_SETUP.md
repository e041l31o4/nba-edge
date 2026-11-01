# NBA EDGE 雲端預測帳本設定

## 1. 建立 Supabase 專案
1. 到 https://supabase.com/dashboard 建立新專案。
2. 開啟 SQL Editor，執行 `supabase/migrations/202611010001_cloud_prediction_ledger.sql`。
3. 到 Project Settings → API，取得 Project URL 與 anon/public key。

## 2. 設定網站環境變數
在 GitHub Repository → Settings → Secrets and variables → Actions → Variables 新增：
- `VITE_SUPABASE_URL` = Project URL
- `VITE_SUPABASE_ANON_KEY` = anon/public key

這兩個值是瀏覽器端公開設定，不可放 service-role key。

## 3. 部署可信任的賽後結算函式
在 Supabase CLI 專案中部署 `supabase/functions/settle-nba-games`：
```sh
supabase functions deploy settle-nba-games
```
Supabase 專案預設已提供 `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 給 Edge Functions。絕不可將 service-role key 放進 Vite 環境變數或 GitHub Pages。

呼叫方式（日期為台灣賽事日期 YYYYMMDD）：
```sh
curl -X POST 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/settle-nba-games' \
  -H 'Content-Type: application/json' \
  -H 'apikey: YOUR_SUPABASE_ANON_KEY' \
  -d '{"date":"20261101"}'
```

## 重要限制
- 預測只允許在開賽前新增，資料表不允許瀏覽器修改或刪除既有預測。
- 結算資料只能由 Edge Function 的 service role 寫入；瀏覽器不能自行改比分。
- Edge Function 目前以 ESPN 公開比分作結算來源，需部署後測試賽事 ID 對應是否與網站 scoreboard adapter 一致。
- 自動排程需另設 Supabase Cron 或 GitHub Actions 呼叫函式；未設定排程前不是背景自動結算。
