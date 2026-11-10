# NBA EDGE 會員系統部署清單

## 架構
- 前端：React + Vite（GitHub Pages）
- 身分驗證與會員資料：Supabase Auth + Postgres + RLS
- 付費方案：固定天數，一次付款；價格由管理後台設定
- 付款：由 Supabase Edge Function 建立訂單及驗證金流伺服器通知
- 權限：管理員永久免費；一般會員必須有有效的已付款訂單

## 安全要求
GitHub Pages 是靜態網站。僅加登入畫面並不能保護目前放在 public/data 的 JSON；任何人都能直接讀取這些網址。
正式啟用付費牆前，必須把預測紀錄、模型資料及其他付費內容移出 public/，放到 Supabase 私有資料表／私有 Storage，並由通過 has_active_membership() 的受保護 API 提供。不可把 Supabase service_role key 放進 VITE_* 或前端程式碼。

## Supabase 初始設定
1. 建立 Supabase 專案。
2. 執行 supabase/migrations/202611100001_membership_core.sql。
3. 在 Authentication 設定 Email provider，並設定正式網站 URL 與 Redirect URLs。
4. 設定前端環境變數：
   - VITE_SUPABASE_URL
   - VITE_SUPABASE_ANON_KEY
5. 管理員先用自己的 Email 註冊一次，再於 Supabase SQL Editor 執行：
   update public.profiles set role = 'admin' where lower(email) = lower('YOUR_ADMIN_EMAIL');
6. 建立 Edge Functions 與金流商機密設定；只在 Supabase secrets 設定 service role / 金流 HashKey、HashIV 等機密，不可提交到 GitHub。

## 付款流程
1. 使用者註冊／登入並選擇方案。
2. Edge Function 從資料庫讀取方案價格與天數，建立 pending 訂單。
3. 導向金流付款頁。
4. 金流伺服器通知回呼至 Edge Function；驗證簽章、商店代號、金額、訂單編號與交易狀態。
5. 只有驗證成功才將訂單標記 paid，並依付款時間及既有有效期限計算 expires_at。
6. 前端只顯示會員有效狀態；到期後由資料庫權限檢查立即拒絕受保護資料。

## 尚待帳戶持有人提供／設定
- Supabase Project URL 與 anon/publishable key（可公開；不可提供 service_role key）
- 管理員登入 Email
- 金流商：綠界或藍新；需自行完成商店申請／審核，之後在 Supabase Secrets 設定金流機密
