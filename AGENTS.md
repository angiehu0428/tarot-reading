# AGENTS.md — 給 Codex 等 AI 代理的協作規則

- 你負責測試與建議：在 `codex/<主題>` 分支工作、用 PR 提出，**不要直接 commit/push main**、不要部署。
- 禁止 force push、禁止改寫已推送的歷史。
- 任何金鑰都不准寫進 repo。
- 專案細節先讀本 repo 的 CLAUDE.md（若存在）與 README.md；驗證最低限度：主要 js 檔 `node --check` 通過。

## app.js 版本管理

- 主程式在 `app.js`，由 `index.html` 的載入器以 `app.js?v=<版本>` 載入（onload/onerror 事件把關、自動重試）。
- **修改 `app.js` 後，務必同步 bump `index.html` 載入器中的 `?v=` 版本字串與頁尾版本號**，否則用戶會拿到舊快取。
