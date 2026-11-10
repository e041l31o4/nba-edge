# NBA EDGE 會員系統部署清單

## 會員制度與付款方式
- 註冊／登入：Email + 密碼（Supabase Auth）。
- 付款方式：銀行轉帳／ATM 匯款，人工核帳；不串接線上金流。
- 會員方案：固定天數、單次付款；價格與天數由管理後台設定。
- 開通方式：會員建立申請並填寫匯款帳號末五碼；管理員確認入帳後，於後台按「確認收款並開通」。
- 管理員：資料庫 role=admin，永久免費，不受會員期限限制。
- 續約：新訂單核准後，從目前有效期限或核准當下較晚者開始延長，避免剩餘天數被吃掉。

## 安全要求（正式上線前必做）
GitHub Pages 是靜態網站。僅加登入畫面並不能保護目前放在 public/data 的 JSON；任何人都能直接讀取這些網址。
正式啟用付費牆前，必須把預測紀錄、模型資料及其他付費內容移出 public/，放到 Supabase 私有資料表／私有 Storage，並由通過 has_active_membership() 的受保護 API 提供。不可把 Supabase service_role key 放進 VITE_* 或前端程式碼。
會員狀態與訂單核准由資料庫 RPC 控制，不能只靠前端按鈕或 localStorage。

## Supabase 初始設定
1. 建立 Supabase 專案。
2. 依序執行：
   - supabase/migrations/202611100001_membership_core.sql
   - supabase/migrations/202611100002_manual_transfer_workflow.sql
   - supabase/migrations/202611100003_private_member_datasets.sql
   - supabase/migrations/202611100004_require_transfer_submission.sql
3. 在 Authentication 設定 Email provider，並設定正式網站 URL 與 Redirect URLs。
4. 設定前端環境變數：VITE_SUPABASE_URL、VITE_SUPABASE_ANON_KEY。
5. 管理員先用自己的 Email 註冊一次，再於 Supabase SQL Editor 執行：
   update public.profiles set role = 'admin' where lower(email) = lower('YOUR_ADMIN_EMAIL');
6. 管理員在後台設定收款銀行、銀行代碼、戶名、帳號及匯款備註。請勿將私人帳戶資料寫死在公開 GitHub 原始碼。

## 人工匯款流程
1. 使用者註冊／登入，選擇會員方案。
2. 系統建立 pending 訂單並顯示管理員設定的匯款資訊。
3. 使用者匯款後，填寫匯款帳號末五碼及備註，送出匯款通知。
4. 管理員到後台核對銀行實際入帳與訂單金額；末五碼只是輔助核對，不代表已付款。
5. 管理員按「確認收款並開通」。資料庫核准函式會把訂單標記 paid 並計算到期日。
6. 會員登入後由資料庫檢查有效期限；到期後拒絕存取付費內容。

## 目前進度（2026-11-10）
- 會員資料表、方案、訂單、RLS 與人工匯款 RPC 已建立。
- 前端註冊／登入、會員中心、管理後台已整合。
- 八類付費資料已移至 Supabase member_datasets，透過 get_member_dataset() 驗證有效會員。
- GitHub Actions 已設定私有資料同步及還原流程；service_role key 僅存放 GitHub Actions Secret。
- 公開 Git 歷史中 public/data 路徑已清理；main 與備份分支均已重寫。
- GitHub Pages 最近一次 Build 與 Deploy 成功。
- 目前 VITE_MEMBERSHIP_ENABLED=false，仍未正式啟用會員牆或收費。

## 尚待實際驗收
- 管理員 Email ruoruo0923@yahoo.com.tw 必須已註冊，並確認 profiles.role = 'admin'。
- 以一般未付款帳號測試 get_member_dataset() 必須遭拒。
- 以已付款會員測試八類資料載入、訂單核准及到期後拒絕存取。
- 完成驗收前不得把 VITE_MEMBERSHIP_ENABLED 改為 true。
- 最新只讀檢查 SQL：supabase/verify-membership-status.sql。
- 最新安全補強 migration：supabase/migrations/202611100004_require_transfer_submission.sql（管理員必須等會員提交匯款末五碼後才能核准）。
- 詳細步驟見 MEMBERSHIP_GO_LIVE_CHECKLIST.md。
