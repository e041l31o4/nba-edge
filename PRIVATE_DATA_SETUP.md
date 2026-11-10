# NBA EDGE 私有資料正式啟用步驟

會員登入、訂單與人工匯款流程已建立。這份設定把模型與預測資料改由 Supabase 會員權限提供；**完成全部步驟前，不要把 `VITE_MEMBERSHIP_ENABLED` 改成 `true`。**

## 1. 套用私有資料資料表

Supabase Dashboard → SQL Editor → New query，貼上並執行：

`supabase/migrations/202611100003_private_member_datasets.sql`

這會建立 `member_datasets` 私有資料表及 `get_member_dataset()` RPC。瀏覽器端不能直接讀取資料表；只有登入且通過 `has_active_membership()` 的會員能透過 RPC 讀取資料。

## 2. 設定 GitHub Actions Secret

GitHub → Settings → Secrets and variables → Actions → New repository secret：

- Name：`SUPABASE_SERVICE_ROLE_KEY`
- Secret：Supabase Dashboard → Project Settings → API Keys 裡的 **service_role / secret key**

只貼到 GitHub Secret，不要貼到聊天、程式碼、`.env.production` 或任何 `VITE_*` 環境變數。前端只使用 publishable/anon key。

## 3. 首次同步私有資料

在 GitHub → Actions，依序手動執行：
1. Refresh Taiwan Sports Lottery NBA odds
2. NBA EDGE prediction ledger
3. NBA EDGE historical walk-forward backtest

確認 workflow 成功，且資料已發布到 Supabase `public.member_datasets`。

## 4. 上線前檢查

- 以管理員登入 NBA EDGE，確認管理後台可正常使用。
- 測試一般註冊帳號不能讀取 `get_member_dataset()`，管理員可以。
- 測試一個已開通會員可正常載入賽前分析、賠率、模型績效及預測紀錄。
- 將 GitHub Actions 的部署設定改為 `VITE_MEMBERSHIP_ENABLED=true`（目前仍是 false），重新部署後，部署流程會從 Pages 公開成品移除 `dist/data`。
- 公開 Git 歷史清理已完成：main 與備份分支的 public/data 歷史路徑均已清除。GitHub Pages 最近一次 Build 與 Deploy 成功。第三方先前已下載、Fork 或快取的副本仍無法保證撤回。

## 注意

目前網站會員限制仍關閉（VITE_MEMBERSHIP_ENABLED=false），尚未正式收費。請先依 MEMBERSHIP_GO_LIVE_CHECKLIST.md 完成管理員、未付款帳號、已付款會員、訂單核准及到期拒絕存取等真實驗收，再開啟會員模式。GitHub Actions 若未設定 Secret，私有資料同步步驟會明確顯示跳過。
