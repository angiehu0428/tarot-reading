# 塔羅占卜 Tarot Reading

線上塔羅占卜 web app：`index.html`（前端單頁）+ `worker.js`（Cloudflare Worker 後端：Gumroad 付款 webhook、Gemini 解讀代理、跨裝置同步）。

## 部署 Deployment

- **worker.js** 由 Cloudflare **Workers Builds** 自動部署：push 到 `main` → 自動執行 `npx wrangler deploy`（worker 名稱：`tarot-worker`）。
- Worker 需要的 Secrets（在 Cloudflare dashboard 設定，不進 repo）：`GUMROAD_SELLER_ID`、`WEBHOOK_SECRET`（Gumroad Ping URL 需帶相同的 `?token=`）、Gemini API key。
- 登入驗證碼寄信（二選一，沒設就沒人登得進來）：Cloudflare Email Sending binding `EMAIL`（`send_email`，網域上線後再加進 wrangler.toml）＋ var `MAIL_FROM`；或 Resend secrets `RESEND_API_KEY` ＋ `EMAIL_FROM`。有綁 `EMAIL` 優先。
- KV：`TAROT_KV`（付費用戶存取記錄、同步資料、登入 session `sess:*`）。
- Durable Objects：`GEMINI_PROXY`（Gemini 美國中繼）、`AUTH_GATE`（登入閘門：驗證碼錯幾次／用過即作廢、購後兌換碼只能兌一次、IP 計數；部署時 migration `v2-auth-gate` 會自動建）。

## 付費功能怎麼驗身分

付費端點（`/gemini`、`/sync`、`/credits`）一律要 `Authorization: Bearer <token>`，光知道 email 不能用。token 來源：
1. `/auth/start {email}` 寄 6 位數驗證碼（只寄給有付費記錄的 email，但回應不分有沒有付費）→ `/auth/verify {email, code}` 回 token（半年有效）。碼 10 分鐘有效、錯 5 次作廢、同一 email 10 分鐘最多猜 10 次。
2. Gumroad 購後轉址帶的 `sale_id`：webhook 收到購買時把它當一次性兌換碼存進 `AUTH_GATE`（30 分鐘、兌一次就作廢）→ `/check {email, sale_id}` 兌成 token。

## 測試

```bash
node --test tests/auth.test.mjs
```
