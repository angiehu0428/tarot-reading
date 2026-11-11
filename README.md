# 塔羅占卜 Tarot Reading

線上塔羅占卜 web app：`index.html`（前端單頁）+ `worker.js`（Cloudflare Worker 後端：Gumroad 付款 webhook、Gemini 解讀代理、跨裝置同步）。

## 部署 Deployment

- **worker.js** 由 Cloudflare **Workers Builds** 自動部署：push 到 `main` → 自動執行 `npx wrangler deploy`（worker 名稱：`tarot-worker`）。
- Worker 需要的 Secrets（在 Cloudflare dashboard 設定，不進 repo）：`GUMROAD_SELLER_ID`、`WEBHOOK_SECRET`（Gumroad Ping URL 需帶相同的 `?token=`）、Gemini API key、`RESEND_API_KEY` ＋ `EMAIL_FROM`（登入驗證碼寄信；兩個都沒設時驗證碼會改丟到站長 Telegram 手動轉交，只適合過渡期）。
- KV：`TAROT_KV`（付費用戶存取記錄、同步資料、登入 session `sess:*`、驗證碼 `otp:*`）。

## 付費功能怎麼驗身分

付費端點（`/gemini`、`/sync`、`/credits`）一律要 `Authorization: Bearer <token>`，光知道 email 不能用。token 來源：
1. `/auth/start {email}` 寄 6 位數驗證碼（只寄給有付費記錄的 email）→ `/auth/verify {email, code}` 回 token（半年有效）。
2. Gumroad 購後轉址帶的 `sale_id` 跟 webhook 寫入的記錄對得上 → `/check {email, sale_id}` 直接回 token。

## 測試

```bash
node --test tests/auth.test.mjs
```
