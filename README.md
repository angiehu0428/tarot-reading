# 塔羅占卜 Tarot Reading

線上塔羅占卜 web app：`index.html`（前端單頁）+ `worker.js`（Cloudflare Worker 後端：Gumroad 付款 webhook、Gemini 解讀代理、跨裝置同步）。

## 部署 Deployment

- **worker.js** 由 Cloudflare **Workers Builds** 自動部署：push 到 `main` → 自動執行 `npx wrangler deploy`（worker 名稱：`tarot-worker`）。
- Worker 需要的 Secrets（在 Cloudflare dashboard 設定，不進 repo）：`GUMROAD_SELLER_ID`、`WEBHOOK_SECRET`（Gumroad Ping URL 需帶相同的 `?token=`）、Gemini API key。
- KV：`TAROT_KV`（付費用戶存取記錄與同步資料）。
