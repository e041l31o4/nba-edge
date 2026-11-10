# NBA EDGE 會員正式上線驗收清單

目前會員功能已整合至網站程式，但會員開關仍為 false。完成本清單並通過實際登入測試前，不得啟用收費。

## 已完成的程式與資料保護項目
- Supabase Auth Email 註冊／登入。
- profiles、membership_plans、membership_orders 及 RLS。
- 人工匯款訂單、末五碼回報、管理員核帳開通。
- 八類資料移至 Supabase member_datasets，瀏覽器透過 get_member_dataset RPC 讀取。
- service_role key 僅放 GitHub Actions Secret；前端使用 publishable key。
- 公開 Git 歷史中 public/data 路徑已清除；main 與備份分支都已改寫。
- GitHub Pages 最近一次 Build 與 Deploy 成功。
- 自動資料流程會在會員模式下從 Supabase 還原資料、更新後再同步，不把付費資料提交至公開 Git。

## 上線前新增的資料庫安全補強
- 請在 Supabase SQL Editor 執行 `supabase/migrations/202611100004_transfer_approval_hardening.sql`。此補強會阻止管理員在會員尚未提交匯款末五碼前直接核准訂單；可重複執行。

## 必須由帳戶持有人完成的實際測試

### A. 管理員帳號
1. 使用管理員 Email 註冊並完成 Email 驗證（若 Supabase 開啟驗證）。
2. 確認已執行 supabase/admin-bootstrap.sql，查詢 role 必須是 admin。
3. 登入後應進入管理後台，而不是一般會員方案頁。
4. 設定實際收款銀行資訊及至少一個正式會員方案。
5. 確認管理員可看到訂單申請與會員 Email。

### B. 一般未付款帳號
1. 使用另一個 Email 註冊及登入。
2. 確認只能看到會員方案、匯款資訊及自己的訂單。
3. 在瀏覽器 Console 以該帳號呼叫 supabase.rpc('get_member_dataset', { p_dataset_key: 'odds' })，必須收到 Active membership required。
4. 嘗試直接查詢 member_datasets，必須被 RLS／權限拒絕。
5. 確認無法看到其他人的訂單或會員資料。

### C. 匯款及開通
1. 未付款帳號建立方案訂單。
2. 填寫五位數匯款末碼及備註，送出後管理員應看到待審核訂單。
3. 管理員只在確認銀行實際入帳後按「確認收款並開通」。
4. 會員重新整理／重新登入後應能載入網站及八類資料。
5. 確認訂單 paid、expires_at 正確，續約應從現有有效期限延長。
6. 測試到期會員必須失去資料讀取權限。

## 尚未由自動化環境證明的項目
- Supabase 真實 Auth 註冊／登入與 Email 驗證。
- 管理員資料庫角色是否與實際登入帳號一致。
- 未付款／已付款帳號的 RPC 權限差異。
- 真實匯款核准及到期後拒絕存取。
- 正式會員模式啟用後的完整網站瀏覽器驗收。

## 正式啟用順序
1. 完成 A、B、C 測試並保存結果。
2. 確認八個 dataset_key 都存在且 updated_at 為最新。
3. 將 .env.production 的 VITE_MEMBERSHIP_ENABLED 設為 true。
4. 觸發 GitHub Pages 部署，確認 dist/data 不存在。
5. 以未付款帳號確認被會員牆擋住；以有效會員確認所有功能可正常使用。
6. 確認所有排程工作成功，且不會把 public/data 寫回公開 Git。
7. 才對外公告會員收費。

注意：Git 歷史清理不代表能撤回第三方先前已下載、Fork 或快取的副本。
