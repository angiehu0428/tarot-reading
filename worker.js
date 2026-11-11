// Tarot Reading — Cloudflare Worker
// KV namespace: TAROT_KV
// Env vars: GEMINI_KEY, GUMROAD_SELLER_ID, STATS_TOKEN, RESEND_API_KEY + EMAIL_FROM（登入驗證碼寄信）

// 全站每日 AI 解牌上限（成本總閘）。想再高/再低就改這個數字。
const DAILY_CAP = 2000;
// 每位付費用戶每日上限（防單一用戶狂刷成本）。30 次對正常使用很夠，可自行調整。
const USER_DAILY_CAP = 30;
function userDayKey(email) { return 'ucount:' + email + ':' + new Date().toISOString().slice(0, 10); }
// 付費 AI 解牌暫停開關（API 配額已滿時設 true；恢復服務時改回 false 並重新部署）
const AI_PAUSED = false;
function todayKey() { return 'count:' + new Date().toISOString().slice(0, 10); }

// Gemini 模型：Google 會定期棄用舊模型／別名（例如 gemini-flash-latest 過去指向的
// gemini-2.0-flash 已於 2026-06-01 下架，導致所有呼叫回傳 404，AI 解牌全面中斷）。
// 別名不可靠，這裡固定寫死目前的正式版模型；之後 Google 再棄用，只需改這一個常數。
// 備援清單：主模型 404（已下架/改名）時依序嘗試，避免單一模型異動就整站中斷。
const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_MODEL_FALLBACKS = ['gemini-flash-latest', 'gemini-flash-lite-latest']; // gemini-2.5-* 已下架（2026-08）
// Gemini 一律從美國出去：Worker 被排到香港機房時 Google 回 400「User location is not supported」，
// [placement] 只是建議擋不住。打 Gemini 的請求交給建在 us jurisdiction 的 Durable Object 轉送（硬限制只在美國跑）。
// 只轉 generativelanguage 的網址，不當任意代理；沒綁定（測試／本機）就直接 fetch。
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/';
export class GeminiProxy {
  constructor(state, env) {}
  async fetch(req) {
    const target = req.headers.get('x-gp-target') || '';
    if (!target.startsWith(GEMINI_HOST)) return new Response('only Gemini', { status: 400 });
    const headers = new Headers(req.headers);
    for (const h of ['x-gp-target', 'host']) headers.delete(h);
    return fetch(target, { method: req.method, headers, body: req.body, signal: AbortSignal.timeout(120000) });
  }
}
let geminiNs; // 每個請求／排程開頭設一次（同一個部署的綁定都一樣）
async function geminiFetch(url, init = {}) {
  if (!geminiNs || !String(url).startsWith(GEMINI_HOST)) return fetch(url, init);
  const us = geminiNs.jurisdiction('us');
  const stub = us.get(us.idFromName('gemini-us'), { locationHint: 'wnam' });
  const headers = new Headers(init.headers);
  headers.set('x-gp-target', String(url));
  const res = await stub.fetch('https://gemini-proxy/', { method: init.method || 'GET', headers, body: init.body });
  return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// 改 worker 時一起改，才能從 /version 確認 Cloudflare 真的部署了新版本
const WORKER_VERSION = '2026.11.11a';

const ALLOWED_ORIGINS = [
  'https://angiehu0428.github.io',
  'https://tarot.angiehu.com',
  'https://color.hucreates.com', // Ink Match / Pantone converter — shares the /report endpoint
];

function corsHeaders(request) {
  const origin = request && request.headers.get('Origin');
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    geminiNs = env.GEMINI_PROXY;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    // Gumroad webhook — called automatically after each purchase
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    // Gemini proxy — called by frontend after email verification
    if (url.pathname === '/gemini' && request.method === 'POST') {
      return handleGemini(request, env);
    }
    // 自備 API Key 被地區擋下時的代轉（用戶自己的 key，不消耗本站額度）
    if (url.pathname === '/gemini-relay' && request.method === 'POST') {
      return handleGeminiRelay(request, env);
    }
    // 版本與執行位置（公開，不含任何機密）：確認新版本已部署、Gemini 走美國中繼（geminiViaUS），
    // egress* 是 Worker 自己的出口，僅供參考。
    if (url.pathname === '/version') {
      return handleVersion(request, env);
    }

    // Email check — with a session token: is this login still paid? With email+sale_id
    // (Gumroad post-purchase redirect): proof of purchase → issues a session token
    if (url.pathname === '/check' && request.method === 'POST') {
      return handleCheck(request, env);
    }
    // Login: email one-time code → session token（付費端點都要帶這個 token，光知道 email 不夠）
    if (url.pathname === '/auth/start' && request.method === 'POST') {
      return handleAuthStart(request, env);
    }
    if (url.pathname === '/auth/verify' && request.method === 'POST') {
      return handleAuthVerify(request, env);
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      return handleAuthLogout(request, env);
    }

    // History sync — paid users sync reading history across devices
    if (url.pathname === '/sync' && request.method === 'POST') {
      return handleSync(request, env);
    }

    // Usage stats — private, view AI-reading counts (key in query)
    if (url.pathname === '/stats' && request.method === 'GET') {
      return handleStats(request, env);
    }

    // Gemini health check — private (key in query); also runs automatically every 6h via Cron Trigger
    if (url.pathname === '/health' && request.method === 'GET') {
      if (!env.STATS_TOKEN || url.searchParams.get('key') !== env.STATS_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      return json(await checkGeminiHealth(env), 200, request);
    }

    // Report / feature wish — store user feedback (no email exposed)
    if (url.pathname === '/report' && request.method === 'POST') {
      return handleReport(request, env);
    }
    // View reports — private, key in query
    if (url.pathname === '/reports' && request.method === 'GET') {
      return handleReports(request, env);
    }
    // Delete one report — private, key in query
    if (url.pathname === '/report-del' && request.method === 'POST') {
      return handleReportDel(request, env);
    }
    // Credit balance query — verified users
    if (url.pathname === '/credits' && request.method === 'POST') {
      return handleCredits(request, env);
    }
    // Credit manual adjust — private, key in query
    if (url.pathname === '/credits-admin' && request.method === 'POST') {
      return handleCreditsAdmin(request, env);
    }
    // Reply to a report (in-app) — private, key in query
    if (url.pathname === '/report-reply' && request.method === 'POST') {
      return handleReportReply(request, env);
    }
    // Fetch replies to my own reports — public, requires per-report token
    if (url.pathname === '/my-replies' && request.method === 'POST') {
      return handleMyReplies(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  // Cloudflare Cron Trigger（見 wrangler.toml 的 [triggers] crons）每 6 小時呼叫一次，
  // ctx.waitUntil 讓檢查在背景跑完，不受單次觸發的執行時間限制影響。
  async scheduled(event, env, ctx) {
    geminiNs = env.GEMINI_PROXY;
    // Gemini 改走美國中繼後，Cron 自己的檢查跟用戶走同一條路，被擋就是真的被擋；
    // 原本量 Worker 出口國家的 checkEgressRegion 已不代表 Gemini 會不會被擋，不再跑
    ctx.waitUntil(checkGeminiHealth(env));
  },
};

// 共用 Telegram 發送（設定 TG_BOT_TOKEN + TG_CHAT_ID 兩個 secret 才會真的送出；
// 失敗不拋錯，呼叫端不需要另外處理）
async function sendTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text.slice(0, 3800) }),
    });
  } catch (e) {}
}

// ── Report / feature wish ────────────────────────────────────
async function handleReport(request, env) {
  const { type, message, contact, ctx, lang, ua, site, err } = await request.json().catch(() => ({}));
  const msg = (message || '').toString().trim().slice(0, 2000);
  if (!msg) return json({ error: 'empty' }, 400, request);
  const id = Date.now();
  // 每筆回報一個隨機 token：回報者憑 id+token 才能讀取站長回覆（避免用 id 亂猜）
  const tok = [...crypto.getRandomValues(new Uint8Array(9))].map(x => x.toString(16).padStart(2, '0')).join('');
  const rec = {
    id, tok,
    date: new Date().toISOString(),
    type: type === 'wish' ? 'wish' : 'issue',
    message: msg,
    contact: (contact || '').toString().trim().slice(0, 120),
    ctx: (ctx || '').toString().slice(0, 40),
    lang: (lang || '').toString().slice(0, 8),
    ua: (ua || '').toString().slice(0, 200),
    site: (site || 'tarot').toString().slice(0, 20), // which site the report came from
    // 診斷用：用戶實際所在國家、處理這個請求的 Cloudflare 節點、以及最近一次 AI 錯誤原文。
    // 「User location is not supported」這類問題光看文字敘述完全查不出原因，
    // 有國家＋節點才分得出是用戶端（VPN／私密轉送）還是我們的節點被擋。
    country: ((request.cf && request.cf.country) || '').toString().slice(0, 8),
    colo: ((request.cf && request.cf.colo) || '').toString().slice(0, 8),
    err: (err || '').toString().slice(0, 300),
  };
  await env.TAROT_KV.put('report:' + id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 365 });
  // Telegram 即時通知：設定 TG_BOT_TOKEN + TG_CHAT_ID 兩個 secret 才啟用；
  // 通知失敗不影響回報本身（KV 已存檔，/reports 一樣看得到）。
  const tgText = `${rec.type === 'wish' ? '💡 功能許願' : '🐞 問題回報'}（${rec.site}）\n\n${rec.message}` +
    (rec.contact ? `\n\n↩ 聯絡方式：${rec.contact}` : '') +
    (rec.err ? `\n⚠ 最近一次 AI 錯誤：${rec.err}` : '') +
    `\n🌐 ${rec.lang || '?'}${rec.ctx ? ' · ' + rec.ctx : ''}` +
    `${rec.country ? ' · ' + rec.country : ''}${rec.colo ? ' · ' + rec.colo : ''}`;
  await sendTelegram(env, tgText);
  return json({ ok: true, id, tok }, 200, request);
}

// ── View reports (private) ───────────────────────────────────
async function handleReports(request, env) {
  const url = new URL(request.url);
  if (!env.STATS_TOKEN || url.searchParams.get('key') !== env.STATS_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  const list = await env.TAROT_KV.list({ prefix: 'report:' });
  const items = [];
  for (const k of list.keys) { const v = await env.TAROT_KV.get(k.name); if (v) { try { items.push(JSON.parse(v)); } catch (e) {} } }
  items.sort((a, b) => b.id - a.id);
  const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = items.map(r => {
    const isWish = r.type === 'wish';
    // 聯絡方式是 email → 給「✉ 回覆」按鈕：mailto 預填收件人/主旨/引文，點開信箱 App 即可回信
    const contact = (r.contact || '').trim();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
    const mailSubject = encodeURIComponent(isWish ? '回覆你在塔羅神諭的功能許願 ✦' : '回覆你在塔羅神諭的問題回報 ✦');
    const mailBody = encodeURIComponent(`你好！我是塔羅神諭的站長 🔮\n\n關於你${isWish ? '許願' : '回報'}的內容：\n「${(r.message || '').slice(0, 300)}」\n\n`);
    const replyBtn = isEmail ? `<a class="reply" href="mailto:${esc(contact)}?subject=${mailSubject}&body=${mailBody}">✉ 回覆</a>` : '';
    return `<div class="card ${isWish ? 'wish' : 'issue'}" data-id="${r.id}">
      <button class="del" onclick="delReport(this)" title="刪除這筆回報">✕</button>
      <div class="meta"><span class="tag">${isWish ? '💡 許願' : '🐞 問題'}</span><span class="site">${esc(r.site || 'tarot')}</span><span class="date">${new Date(r.date).toLocaleString('zh-TW')}</span>${r.ctx ? `<span class="ctx">${esc(r.ctx)}</span>` : ''}<span class="lang">${esc(r.lang)}</span>${r.country ? `<span class="ctx">${esc(r.country)}${r.colo ? ' · ' + esc(r.colo) : ''}</span>` : ''}</div>
      <div class="msg">${esc(r.message)}</div>
      ${r.err ? `<div class="err">⚠ ${esc(r.err)}</div>` : ''}
      ${contact ? `<div class="contact">↩ ${esc(contact)} ${replyBtn}</div>` : ''}
      <div class="inreply">
        ${r.reply ? `<div class="replied">💌 已回覆（${r.repliedAt ? new Date(r.repliedAt).toLocaleString('zh-TW') : ''}）：${esc(r.reply)}</div>` : ''}
        <div class="replyrow">
          <textarea class="replybox" rows="2" placeholder="站內回覆：用戶下次打開網站會看到「站長回覆」視窗">${r.reply ? esc(r.reply) : ''}</textarea>
          <button class="replysend" onclick="sendReply(this)">${r.reply ? '更新回覆' : '💬 站內回覆'}</button>
        </div>
      </div>
      <div class="ua">${esc(r.ua)}</div>
    </div>`;
  }).join('');
  const issues = items.filter(r => r.type !== 'wish').length;
  const wishes = items.filter(r => r.type === 'wish').length;
  const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>用戶回報 · 塔羅神諭</title>
<style>
  body{margin:0;background:#08031a;color:#b8b0c8;font-family:'Noto Serif TC',serif;padding:28px 16px;line-height:1.6}
  .wrap{max-width:680px;margin:0 auto}
  h1{font-family:Georgia,serif;color:#d4af37;font-size:1.3rem;text-align:center;letter-spacing:.06em}
  .sub{text-align:center;color:#9a8db5;font-size:.82rem;margin-bottom:22px}
  .card{background:rgba(42,22,96,.25);border:1px solid rgba(212,175,55,.2);border-radius:12px;padding:16px 18px;margin-bottom:14px;position:relative}
  .del{position:absolute;top:10px;right:10px;background:none;border:1px solid rgba(224,85,85,.3);color:rgba(224,85,85,.7);width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:.8rem;line-height:1;transition:all .2s}
  .del:hover{background:rgba(224,85,85,.15);color:#e05555}
  .card.wish{border-color:rgba(120,180,255,.3)}
  .err{font-size:.75rem;color:#e0a055;background:rgba(224,160,85,.08);border-radius:8px;padding:7px 10px;margin-top:8px;word-break:break-word}
  .meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:.74rem;color:#9a8db5;margin-bottom:8px}
  .tag{color:#f0d878;font-weight:700}
  .card.wish .tag{color:#9ec5ff}
  .ctx,.lang{background:rgba(255,255,255,.06);border-radius:4px;padding:1px 6px}
  .site{background:rgba(120,180,255,.14);color:#9ec5ff;border-radius:4px;padding:1px 7px;font-weight:700;letter-spacing:.04em}
  .msg{color:#efe9ff;font-size:.95rem;white-space:pre-wrap;line-height:1.7}
  .contact{margin-top:8px;color:#d4af37;font-size:.82rem}
  .reply{display:inline-block;margin-left:8px;padding:2px 12px;border:1px solid rgba(212,175,55,.5);border-radius:50px;color:#f0d878;text-decoration:none;font-size:.78rem;transition:all .2s}
  .reply:hover{background:rgba(212,175,55,.15)}
  .inreply{margin-top:10px}
  .replied{color:#8fd19e;font-size:.8rem;margin-bottom:6px;white-space:pre-wrap}
  .replyrow{display:flex;gap:8px;align-items:flex-end}
  .replybox{flex:1;min-width:0;background:rgba(8,3,26,.5);border:1px solid rgba(212,175,55,.25);border-radius:8px;color:#efe9ff;font-family:inherit;font-size:.85rem;padding:8px 10px;resize:vertical}
  .replysend{flex-shrink:0;background:rgba(212,175,55,.12);border:1px solid rgba(212,175,55,.45);border-radius:8px;color:#f0d878;cursor:pointer;font-size:.8rem;padding:8px 14px}
  .replysend:hover{background:rgba(212,175,55,.22)}
  .ua{margin-top:6px;color:#5a4d75;font-size:.66rem;word-break:break-all}
  .empty{text-align:center;color:#6a5d85;padding:40px}
</style></head><body><div class="wrap">
  <h1>✦ 用戶回報 ✦</h1>
  <div class="sub">塔羅神諭 · 🐞 問題 ${issues} 件 · 💡 許願 ${wishes} 件</div>
  ${rows || '<div class="empty">目前還沒有任何回報</div>'}
</div>
<script>
async function sendReply(btn){
  const card=btn.closest('.card');
  const txt=card.querySelector('.replybox').value.trim();
  if(!txt){alert('請先輸入回覆內容');return;}
  const key=new URLSearchParams(location.search).get('key');
  btn.disabled=true;btn.textContent='送出中...';
  const r=await fetch('/report-reply?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:card.dataset.id,reply:txt})}).catch(()=>null);
  if(r&&r.ok){btn.textContent='✓ 已回覆';setTimeout(()=>{btn.disabled=false;btn.textContent='更新回覆';},1200);}
  else{btn.disabled=false;btn.textContent='送出失敗，重試';}
}
async function delReport(btn){
  if(!confirm('確定刪除這筆回報？（無法復原）'))return;
  const card=btn.closest('.card');
  const key=new URLSearchParams(location.search).get('key');
  btn.disabled=true;
  const r=await fetch('/report-del?key='+encodeURIComponent(key)+'&id='+encodeURIComponent(card.dataset.id),{method:'POST'}).catch(()=>null);
  if(r&&r.ok){card.style.opacity='0';setTimeout(()=>card.remove(),250);}
  else{btn.disabled=false;alert('刪除失敗，請重試');}
}
</script>
</body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Reply to a report, shown in-app (private) ────────────────
async function handleReportReply(request, env) {
  const url = new URL(request.url);
  if (!env.STATS_TOKEN || url.searchParams.get('key') !== env.STATS_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  const { id, reply } = await request.json().catch(() => ({}));
  const rid = String(id || '').replace(/\D/g, '');
  const txt = (reply || '').toString().trim().slice(0, 2000);
  if (!rid || !txt) return json({ error: 'bad request' }, 400, request);
  const raw = await env.TAROT_KV.get('report:' + rid);
  if (!raw) return json({ error: 'not found' }, 404, request);
  const rec = JSON.parse(raw);
  rec.reply = txt;
  rec.repliedAt = new Date().toISOString();
  await env.TAROT_KV.put('report:' + rid, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 365 });
  return json({ ok: true }, 200, request);
}

// ── Fetch replies to my own reports (public, token-gated) ────
async function handleMyReplies(request, env) {
  const { items } = await request.json().catch(() => ({}));
  if (!Array.isArray(items)) return json({ replies: [] }, 200, request);
  const out = [];
  for (const it of items.slice(0, 20)) {
    const rid = String((it && it.id) || '').replace(/\D/g, '');
    if (!rid) continue;
    const raw = await env.TAROT_KV.get('report:' + rid);
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      // token 必須相符（舊回報沒有 tok 則不回傳，避免洩漏）
      if (!rec.tok || rec.tok !== (it && it.tok)) continue;
      if (!rec.reply) continue;
      out.push({ id: rec.id, type: rec.type, message: (rec.message || '').slice(0, 200), reply: rec.reply, repliedAt: rec.repliedAt });
    } catch (e) {}
  }
  return json({ replies: out }, 200, request);
}

// ── Delete one report (private) ──────────────────────────────
async function handleReportDel(request, env) {
  const url = new URL(request.url);
  if (!env.STATS_TOKEN || url.searchParams.get('key') !== env.STATS_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
  if (!id) return new Response('Bad id', { status: 400 });
  await env.TAROT_KV.delete('report:' + id);
  return new Response('OK');
}

// 訂閱存取期限：每次扣款後給約 40 天（月扣款 + 寬限）。Gumroad 每次續扣都會再打一次
// webhook，自動刷新此期限；一旦停止續訂，存取會在約 40 天內自動失效。
const SUB_TTL = 60 * 60 * 24 * 40;
// 舊式「一次性購買」的存取期限（2 年）。現有已付費用戶沿用此設定、不受訂閱制影響。
const LIFETIME_TTL = 60 * 60 * 24 * 730;

// ── Gumroad webhook ──────────────────────────────────────────
async function handleWebhook(request, env) {
  // Shared-secret check: Gumroad "Ping" has no HMAC, so we require a secret token
  // in the webhook URL (…/webhook?token=XXX). Only enforced once WEBHOOK_SECRET is
  // set, so deploying this does NOT break live payments before you update Gumroad.
  if (env.WEBHOOK_SECRET) {
    const token = new URL(request.url).searchParams.get('token') || '';
    if (token !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
  }

  const text = await request.text();
  const params = new URLSearchParams(text);

  const sellerId = params.get('seller_id');
  const email = params.get('email')?.toLowerCase().trim();
  const saleId = params.get('sale_id') || '';
  const subId = params.get('subscription_id') || '';   // 訂閱才有
  const refunded = params.get('refunded') === 'true';
  // 訂閱「真正結束」或「扣款失敗」→ 撤銷存取。
  // 注意：單純「取消但本期尚未到期」不在此撤銷，讓存取靠 TTL 自然到期（等於用到付費期末）。
  const ended = !!(params.get('subscription_ended_at') || params.get('subscription_failed_at'));

  // Verify this is from your Gumroad account
  if (!env.GUMROAD_SELLER_ID || sellerId !== env.GUMROAD_SELLER_ID) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (!email) return new Response('No email', { status: 400 });

  // ── Credit 儲值商品分流 ──
  // env.CREDIT_PRODUCTS 格式："<permalink或product_id>:<點數>,..."（如 "crdt100:100,crdt300:300"）
  // 命中 → 入點數後直接返回，「不」寫入訂閱驗證記錄
  const productKeys = [params.get('permalink'), params.get('product_id'), params.get('product_permalink')]
    .filter(Boolean).map(x => x.toString().split('/').pop().toLowerCase());
  const creditMap = {};
  (env.CREDIT_PRODUCTS || '').split(',').forEach(pair => {
    const [k, v] = pair.split(':').map(x => (x || '').trim());
    if (k && v) creditMap[k.toLowerCase()] = parseInt(v, 10) || 0;
  });
  const packKey = productKeys.find(k => creditMap[k] > 0);
  if (packKey) {
    const pack = creditMap[packKey];
    const ck = `credits:${email}`;
    const bal = parseInt((await env.TAROT_KV.get(ck)) || '0', 10);
    if (refunded) {
      await env.TAROT_KV.put(ck, String(Math.max(0, bal - pack)));
      return new Response('OK');
    }
    // 同一筆 sale 只入帳一次（Gumroad ping 可能重送）
    if (saleId) {
      const seen = await env.TAROT_KV.get(`csale:${saleId}`);
      if (seen) return new Response('OK');
      await env.TAROT_KV.put(`csale:${saleId}`, '1', { expirationTtl: 60 * 60 * 24 * 90 });
    }
    await env.TAROT_KV.put(ck, String(bal + pack));
    return new Response('OK');
  }

  if (refunded || ended) {
    // 退款 / 訂閱結束 → 移除存取
    await env.TAROT_KV.delete(`email:${email}`);
    return new Response('OK');
  }

  // 有 subscription_id → 訂閱用戶，用短 TTL（每次扣款自動刷新）；
  // 無 subId → 舊式一次性購買，沿用 2 年 TTL（不影響既有付費用戶）。
  const ttl = subId ? SUB_TTL : LIFETIME_TTL;
  await env.TAROT_KV.put(
    `email:${email}`,
    JSON.stringify({ verified: true, date: new Date().toISOString(), saleId, subId, plan: subId ? 'sub' : 'lifetime' }),
    { expirationTtl: ttl }
  );
  // 購後轉址的一次性兌換碼：買家瀏覽器會帶著同一個 sale_id 回站上（見 handleCheck），
  // 30 分鐘內兌一次就作廢。存失敗不影響付款記錄（用戶還是能走驗證碼登入）
  if (saleId && env.AUTH_GATE) {
    try { await gate(env, `email:${email}`, { op: 'redeem_put', h: await sha256Hex(`sale:${saleId}`), ttlMs: REDEEM_TTL_MS }); } catch (e) {}
  }

  return new Response('OK');
}

// ── Credit balance ───────────────────────────────────────────
async function handleCredits(request, env) {
  const s = await requirePaidSession(request, env);
  if (s.error) return s.error;
  const bal = parseInt((await env.TAROT_KV.get(`credits:${s.email}`)) || '0', 10);
  return json({ balance: bal }, 200, request);
}

// ── Credit manual adjust (private; for support/testing) ──────
async function handleCreditsAdmin(request, env) {
  const url = new URL(request.url);
  if (!env.STATS_TOKEN || url.searchParams.get('key') !== env.STATS_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  const { email, delta } = await request.json().catch(() => ({}));
  const e = (email || '').toLowerCase().trim();
  const d = parseInt(delta, 10);
  if (!e || isNaN(d)) return json({ error: 'bad request' }, 400, request);
  const ck = `credits:${e}`;
  const bal = Math.max(0, parseInt((await env.TAROT_KV.get(ck)) || '0', 10) + d);
  await env.TAROT_KV.put(ck, String(bal));
  return json({ ok: true, balance: bal }, 200, request);
}

// ── Login / session ──────────────────────────────────────────
// 2026-11 以前 /gemini、/sync、/credits 只看 body 裡的 email 有沒有付費記錄，知道別人的
// email 就能讀他的占卜記錄、清空它、燒他的點數。現在改成：
//   /auth/start  {email}        → 有付費記錄才寄 6 位數驗證碼（10 分鐘有效）；回應不分有沒有付費
//   /auth/verify {email, code}  → 對了就發隨機 session token（KV `sess:<token>` → email）
//   付費端點一律要 `Authorization: Bearer <token>`，email 以 token 對出來的為準
//   /check {email, sale_id}     → Gumroad 購後轉址帶的 sale_id 當「一次性兌換碼」：webhook 收到購買時
//                                 把它的雜湊存進 AuthGate（30 分鐘、只能兌一次），對得上就發 token
// 驗證碼的「錯幾次／用過一次就作廢」、兌換碼的「只能兌一次」、IP 計數，都放在 Durable Object
// AuthGate 裡做（每個 email／IP 一個物件，單執行緒，同時打進來的請求會排隊，不會像 KV 那樣
// read-then-write 互相蓋掉）。session token 本身只是隨機字串，放 KV 就夠。
const SESSION_TTL = 60 * 60 * 24 * 180; // 半年；到期就再收一次驗證碼
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_TRIES = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const VERIFY_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_WINDOW_CAP = 10;          // 同一個 email 10 分鐘內最多猜幾次（不分對錯、不分 OTP 新舊）
const AUTH_IP_HOURLY_CAP = 20;         // 每個 IP 每小時最多幾次「寄碼」（防拿 /auth/start 掃信箱）
const VERIFY_IP_HOURLY_CAP = 60;       // 每個 IP 每小時最多幾次「猜碼」
const REDEEM_TTL_MS = 30 * 60 * 1000;  // Gumroad 購後兌換碼有效期
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 每個 email（otp／兌換碼）或 IP（計數）一個物件。所有「讀了再寫」都在同一個事件裡完成：
// Durable Object 在等 storage 的時候不會接新的請求（input gate），所以天然是原子的。
export class AuthGate {
  constructor(state, env) { this.storage = state.storage; }
  async fetch(req) {
    const a = await req.json().catch(() => ({}));
    const st = this.storage;
    const now = Date.now();
    const out = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    switch (a.op) {
      case 'otp_start': {
        const until = (await st.get('cooldownUntil')) || 0;
        if (now < until) return out({ cooldown: true });
        await st.put('otp', { h: a.h, exp: now + a.ttlMs, tries: 0 });
        await st.put('cooldownUntil', now + a.cooldownMs);
        return out({ ok: true });
      }
      case 'otp_cancel': { // 信沒寄出去：把剛存的碼跟冷卻一起撤掉，讓用戶能馬上重試
        await st.delete(['otp', 'cooldownUntil']);
        return out({ ok: true });
      }
      case 'otp_verify': {
        let w = (await st.get('vwin')) || { start: now, n: 0 };
        if (now - w.start > a.windowMs) w = { start: now, n: 0 };
        w.n += 1;
        await st.put('vwin', w);
        if (w.n > a.cap) return out({ limited: true });
        const otp = await st.get('otp');
        if (!otp || otp.exp < now) { if (otp) await st.delete('otp'); return out({ expired: true }); }
        if (otp.h !== a.h) {
          otp.tries += 1;
          if (otp.tries >= a.maxTries) { await st.delete('otp'); return out({ expired: true, exhausted: true }); }
          await st.put('otp', otp);
          return out({ wrong: true, left: a.maxTries - otp.tries });
        }
        await st.delete('otp'); // 對了就作廢，第二個人拿同一組碼進來只會看到 expired
        return out({ ok: true });
      }
      case 'redeem_put': {
        await st.put('redeem', { h: a.h, exp: now + a.ttlMs });
        return out({ ok: true });
      }
      case 'redeem_take': {
        const r = await st.get('redeem');
        if (!r || r.exp < now || r.h !== a.h) return out({ ok: false });
        await st.delete('redeem');
        return out({ ok: true });
      }
      case 'hit': { // 固定視窗計數（IP 限流）
        let w = (await st.get('hits')) || { start: now, n: 0 };
        if (now - w.start > a.windowMs) w = { start: now, n: 0 };
        if (w.n >= a.cap) return out({ allowed: false });
        w.n += 1;
        await st.put('hits', w);
        return out({ allowed: true });
      }
      default:
        return new Response('bad op', { status: 400 });
    }
  }
}
async function gate(env, name, payload) {
  const ns = env.AUTH_GATE;
  const stub = ns.get(ns.idFromName(name));
  const res = await stub.fetch('https://auth-gate/', { method: 'POST', body: JSON.stringify(payload) });
  return res.json();
}
function gateMissing(env, request) {
  if (env.AUTH_GATE) return null;
  return json({ error: '登入服務尚未設定（缺 AUTH_GATE 綁定）/ Sign-in is not configured', unconfigured: true }, 503, request);
}

function normEmail(v) { return String(v || '').toLowerCase().trim().slice(0, 254); }
function safeJson(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
function randomHex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
function bearerToken(request) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(request.headers.get('Authorization') || '');
  return m ? m[1].toLowerCase() : '';
}
async function issueSession(env, email) {
  const token = randomHex(32);
  await env.TAROT_KV.put(`sess:${token}`, JSON.stringify({ email, iat: new Date().toISOString() }), { expirationTtl: SESSION_TTL });
  return token;
}
// token → { email, record }（record = 付費記錄，null 表示訂閱已到期/退款）；沒 token 或 token 無效 → null
async function readSession(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const sess = safeJson((await env.TAROT_KV.get(`sess:${token}`)) || '');
  const email = sess && normEmail(sess.email);
  if (!email) return null;
  const record = await env.TAROT_KV.get(`email:${email}`);
  return { email, record, token };
}
// 付費端點共用：回 { email } 或 { error: Response }
async function requirePaidSession(request, env) {
  const s = await readSession(request, env);
  if (!s) return { error: json({ error: '請先驗證 Email 登入 / Please verify your email to sign in', needLogin: true }, 401, request) };
  if (!s.record) return { error: json({ error: '此 email 尚未驗證付款。請確認使用 Gumroad 購買時的 email。', notPaid: true }, 403, request) };
  return s;
}
// 每個 IP 每小時的計數（在 AuthGate 裡做，原子）
async function ipAllow(env, request, bucket, cap) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const r = await gate(env, `ip:${bucket}:${ip}`, { op: 'hit', cap, windowMs: 60 * 60 * 1000 });
  return !!r.allowed;
}
// 站長通知節流：同一件事一小時只吵一次
async function alertOnce(env, key, text) {
  const k = `alert:${key}`;
  if (await env.TAROT_KV.get(k)) return;
  await env.TAROT_KV.put(k, '1', { expirationTtl: 60 * 60 });
  await sendTelegram(env, text);
}
// 「名字 <addr>」或純 addr → Email Sending binding 要的 from
function parseFrom(v) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(String(v || ''));
  return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2].trim() } : String(v || '').trim();
}
// 寄驗證碼。優先用 Cloudflare Email Sending binding（wrangler 的 send_email，名字 EMAIL，寄件人 MAIL_FROM），
// 沒綁就走 Resend（RESEND_API_KEY + EMAIL_FROM，跟 Angie 其他專案同一套）。
// 只有寄件端明確回成功才算寄出；兩個都沒設 → 回失敗，不代寄、不把碼丟去別的地方。
async function sendLoginCode(env, email, code) {
  const subject = `塔羅占卜驗證碼 ${code} / Your Tarot verification code`;
  const text = `你的塔羅占卜登入驗證碼：${code}\n10 分鐘內有效。不是你本人操作的話，直接忽略這封信就好。\n\nYour Tarot Reading sign-in code: ${code}\nIt expires in 10 minutes. If this wasn't you, just ignore this email.`;
  const html = `<p>你的塔羅占卜登入驗證碼：</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p><p>10 分鐘內有效。不是你本人操作的話，直接忽略這封信就好。</p><hr><p>Your Tarot Reading sign-in code:</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p><p>It expires in 10 minutes. If this wasn't you, just ignore this email.</p>`;
  if (env.EMAIL && env.MAIL_FROM) {
    try {
      await env.EMAIL.send({ to: email, from: parseFrom(env.MAIL_FROM), subject, text, html });
      return { ok: true, via: 'email' };
    } catch (e) {
      await alertOnce(env, 'mailfail', `⚠️ 塔羅登入驗證碼寄信失敗（Email Sending）：${String(e && e.message || e).slice(0, 200)}`);
      return { ok: false, reason: 'send' };
    }
  }
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text, html }),
      });
      if (res.ok) return { ok: true, via: 'email' };
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      await alertOnce(env, 'mailfail', `⚠️ 塔羅登入驗證碼寄信失敗（Resend ${res.status}）：${detail}`);
      return { ok: false, reason: 'send' };
    } catch (e) {
      await alertOnce(env, 'mailfail', `⚠️ 塔羅登入驗證碼寄信失敗：${String(e && e.message || e).slice(0, 200)}`);
      return { ok: false, reason: 'send' };
    }
  }
  await alertOnce(env, 'mailunset', '⚠️ 塔羅有付費用戶想登入，但 worker 還沒設寄信（EMAIL 綁定＋MAIL_FROM，或 RESEND_API_KEY＋EMAIL_FROM），用戶被擋在外面');
  return { ok: false, reason: 'unconfigured' };
}

// 回應不分「有沒有付費記錄」，免得被拿來掃哪些 email 是付費用戶
const START_GENERIC = { sent: true, message: '如果這個 Email 有購買記錄，驗證碼已寄出（10 分鐘內有效）/ If this email has a purchase, a code is on its way (valid 10 min)' };

async function handleAuthStart(request, env) {
  const missing = gateMissing(env, request); if (missing) return missing;
  const { email } = await request.json().catch(() => ({}));
  const e = normEmail(email);
  if (!e || !EMAIL_RE.test(e)) return json({ error: '請輸入正確的 Email / Please enter a valid email' }, 400, request);
  if (!(await ipAllow(env, request, 'start', AUTH_IP_HOURLY_CAP))) {
    return json({ error: '嘗試太多次，請一小時後再試 / Too many attempts, please try again in an hour', rateLimited: true }, 429, request);
  }
  const record = await env.TAROT_KV.get(`email:${e}`);
  if (!record) return json(START_GENERIC, 200, request);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const g = await gate(env, `email:${e}`, { op: 'otp_start', h: await sha256Hex(`${e}:${code}`), ttlMs: OTP_TTL_MS, cooldownMs: OTP_RESEND_COOLDOWN_MS });
  if (g.cooldown) return json(START_GENERIC, 200, request); // 60 秒內已寄過：不再寄，回應也長一樣
  const sent = await sendLoginCode(env, e, code);
  if (!sent.ok) {
    await gate(env, `email:${e}`, { op: 'otp_cancel' }); // 沒寄出去就撤掉，讓用戶能馬上重試
    const msg = sent.reason === 'unconfigured'
      ? '寄信服務尚未設定，暫時無法登入，請聯絡站長 / Sign-in email is not set up yet — please contact support'
      : '驗證碼寄不出去，請稍後再試 / Could not send the code, please try again later';
    return json({ error: msg, mailFailed: true }, 503, request);
  }
  return json(START_GENERIC, 200, request);
}

async function handleAuthVerify(request, env) {
  const missing = gateMissing(env, request); if (missing) return missing;
  const { email, code } = await request.json().catch(() => ({}));
  const e = normEmail(email);
  const c = String(code || '').replace(/\D/g, '');
  if (!e || c.length !== 6) return json({ error: '請輸入 6 位數驗證碼 / Enter the 6-digit code' }, 400, request);
  if (!(await ipAllow(env, request, 'verify', VERIFY_IP_HOURLY_CAP))) {
    return json({ error: '嘗試太多次，請一小時後再試 / Too many attempts, please try again in an hour', rateLimited: true }, 429, request);
  }
  const g = await gate(env, `email:${e}`, { op: 'otp_verify', h: await sha256Hex(`${e}:${c}`), maxTries: OTP_MAX_TRIES, windowMs: VERIFY_WINDOW_MS, cap: VERIFY_WINDOW_CAP });
  if (g.limited) return json({ error: '嘗試太多次，請 10 分鐘後再重寄驗證碼 / Too many attempts, request a new code in 10 minutes', rateLimited: true }, 429, request);
  if (g.expired) {
    return json({ error: g.exhausted ? '錯太多次，請重新寄驗證碼 / Too many wrong tries, please request a new code' : '驗證碼已過期，請重新寄一次 / Code expired, please request a new one', expired: true }, 401, request);
  }
  if (g.wrong) return json({ error: '驗證碼不對 / Wrong code', wrong: true, left: g.left }, 401, request);
  if (!g.ok) return json({ error: '驗證失敗 / Verification failed' }, 401, request);
  const record = await env.TAROT_KV.get(`email:${e}`);
  if (!record) return json({ error: 'no purchase', verified: false }, 403, request);
  const token = await issueSession(env, e);
  return json({ ok: true, verified: true, token, email: e }, 200, request);
}

async function handleAuthLogout(request, env) {
  const token = bearerToken(request);
  if (token) await env.TAROT_KV.delete(`sess:${token}`);
  return json({ ok: true }, 200, request);
}

// ── Check if the login is (still) paid ────────────────────────
async function handleCheck(request, env) {
  const { email, sale_id } = await request.json().catch(() => ({}));
  const s = await readSession(request, env);
  if (s) return json({ verified: !!s.record, email: s.email }, 200, request);

  // Gumroad 購後轉址（?email=&sale_id=）：sale_id 當一次性兌換碼——webhook 收到這筆購買時
  // 存進 AuthGate（30 分鐘、只能兌一次），兌掉就作廢，網址歷史裡留著也沒用
  const e = normEmail(email);
  const sid = String(sale_id || '').trim().slice(0, 100);
  if (e && sid && env.AUTH_GATE) {
    if (!(await ipAllow(env, request, 'check', AUTH_IP_HOURLY_CAP))) return json({ verified: false, rateLimited: true }, 429, request);
    const r = await gate(env, `email:${e}`, { op: 'redeem_take', h: await sha256Hex(`sale:${sid}`) });
    if (r.ok && await env.TAROT_KV.get(`email:${e}`)) {
      const token = await issueSession(env, e);
      return json({ verified: true, token, email: e }, 200, request);
    }
  }
  // 沒 token 就不回答「這個 email 有沒有付費」（以前是個查詢機）
  return json({ verified: false, needLogin: true }, 200, request);
}

// ── History sync (paid users only) ───────────────────────────
async function handleSync(request, env) {
  const { action, readings, full, projects } = await request.json().catch(() => ({}));
  const s = await requirePaidSession(request, env);
  if (s.error) return s.error;
  const e = s.email;

  const key = `hist:${e}`;
  if (action === 'pull') {
    const stored = await env.TAROT_KV.get(key);
    return json(stored ? JSON.parse(stored) : { readings: [], full: [] }, 200, request);
  }
  if (action === 'push') {
    const payload = JSON.stringify({
      readings: Array.isArray(readings) ? readings.slice(0, 60) : [],
      full: Array.isArray(full) ? full.slice(0, 60) : [],
      projects: Array.isArray(projects) ? projects.slice(0, 30) : [], // 專案也同步（含各自的占卜記錄）
      updated: new Date().toISOString(),
    });
    await env.TAROT_KV.put(key, payload, { expirationTtl: 60 * 60 * 24 * 730 });
    return json({ ok: true }, 200, request);
  }
  return json({ error: 'bad action' }, 400, request);
}

// ── Usage stats (private) ────────────────────────────────────
async function handleStats(request, env) {
  const url = new URL(request.url);
  if (!env.STATS_TOKEN || url.searchParams.get('key') !== env.STATS_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  const days = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    const n = parseInt((await env.TAROT_KV.get('count:' + d)) || '0', 10);
    days.push({ date: d, aiReadings: n });
  }
  // JSON if explicitly requested; otherwise a friendly HTML page
  if (url.searchParams.get('format') === 'json') {
    return json({ dailyCap: DAILY_CAP, today: days[0], last7days: days }, 200, request);
  }
  const today = days[0];
  const pct = Math.min(100, Math.round((today.aiReadings / DAILY_CAP) * 100));
  const max = Math.max(DAILY_CAP, ...days.map(d => d.aiReadings)) || 1;
  const rows = days.map(d => {
    const w = Math.round((d.aiReadings / max) * 100);
    return `<div class="row"><span class="date">${d.date}</span><div class="bar"><div class="fill" style="width:${w}%"></div></div><span class="num">${d.aiReadings}</span></div>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>用量統計 · 塔羅神諭</title>
<style>
  body{margin:0;background:#08031a;color:#b8b0c8;font-family:'Noto Serif TC',serif;padding:32px 18px;line-height:1.6}
  .wrap{max-width:560px;margin:0 auto}
  h1{font-family:Georgia,serif;color:#d4af37;font-size:1.4rem;text-align:center;letter-spacing:.08em}
  .sub{text-align:center;color:#9a8db5;font-size:.82rem;margin-bottom:26px}
  .card{background:rgba(42,22,96,.25);border:1px solid rgba(212,175,55,.2);border-radius:14px;padding:22px;margin-bottom:18px}
  .big{font-size:2.6rem;color:#f0d878;font-weight:700;text-align:center;line-height:1.1}
  .cap{text-align:center;color:#9a8db5;font-size:.9rem;margin-top:4px}
  .meter{height:12px;background:rgba(255,255,255,.07);border-radius:6px;overflow:hidden;margin-top:16px}
  .meter>div{height:100%;background:linear-gradient(90deg,#d4af37,#f0d878);width:${pct}%}
  .pct{text-align:center;color:${pct >= 90 ? '#e05555' : '#d4af37'};font-size:.82rem;margin-top:8px}
  h2{color:#d4af37;font-size:.9rem;letter-spacing:.08em;margin:0 0 12px}
  .row{display:flex;align-items:center;gap:10px;margin-bottom:9px;font-size:.85rem}
  .date{color:#9a8db5;width:88px;flex-shrink:0}
  .bar{flex:1;height:10px;background:rgba(255,255,255,.06);border-radius:5px;overflow:hidden}
  .fill{height:100%;background:rgba(212,175,55,.65)}
  .num{color:#fff;width:34px;text-align:right;flex-shrink:0}
</style></head><body><div class="wrap">
  <h1>✦ AI 解牌用量 ✦</h1>
  <div class="sub">塔羅神諭 · 成本監控（世界時間 UTC）</div>
  <div class="card">
    <div class="big">${today.aiReadings} <span style="font-size:1rem;color:#9a8db5">/ ${DAILY_CAP}</span></div>
    <div class="cap">今日已用 / 每日上限</div>
    <div class="meter"><div></div></div>
    <div class="pct">${pct}% ${pct >= 90 ? '· 接近上限！' : pct >= 50 ? '· 用量偏高' : '· 安全'}</div>
  </div>
  <div class="card">
    <h2>近 7 天</h2>
    ${rows}
  </div>
  <div style="text-align:center;color:#6a5d85;font-size:.72rem">超過每日上限會自動暫停 AI 解牌，用戶改用免費內建解讀，成本不會爆量。</div>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 要不要改用下一個備援模型：
// ① 404 → 這個模型不存在/已下架（Google 會定期棄用）。
// ② 模型忙線（503 / overloaded / high demand）→ 是「這個模型」當下沒容量，換一個通常就過了。
// 配額不足（429 RESOURCE_EXHAUSTED）不換——那是金鑰層級的限制，換模型沒用。
// 其他錯誤（參數錯誤、地區被擋等）也不換，直接回傳，不掩蓋真正的問題。
function shouldTryNextModel(status, data) {
  if (status === 404) return true;
  const m = String((data && data.error && data.error.message) || '');
  if (/RESOURCE_EXHAUSTED|check quota/i.test(m)) return false;
  return status === 503 || /overloaded|high demand|Spikes in demand|UNAVAILABLE/i.test(m);
}

// 依序嘗試 GEMINI_MODEL 與其備援模型，直到取得可用的回應
async function fetchGeminiWithFallback(apiKey, geminiBody) {
  const models = [GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS];
  let resp, data;
  for (const model of models) {
    resp = await geminiFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(geminiBody),
      }
    );
    data = await resp.json().catch(() => ({}));
    if (!shouldTryNextModel(resp.status, data)) return { resp, data };
  }
  return { resp, data }; // 全部模型都不行：回傳最後一次的結果，讓上層照常回報錯誤
}

// Gemini API 不支援的地區（台灣用戶最可能被路由到的是香港）。這是「出口國家」的黑名單，
// 不是用戶所在地——用戶在哪都沒關係，重點是請求從哪裡送出去。
const UNSUPPORTED_REGIONS = ['HK', 'MO', 'CN'];
// 用戶實際走的路徑（fetch handler）受 wrangler.toml 的 [placement] 固定在美西；
// 定期檢查自己打這個網址，就能確認 placement 還活著、出口仍在支援地區。
const WORKER_PUBLIC_URL = 'https://tarot-worker.angiehu.workers.dev';

// ── 地區限制（Google 依「請求送出來的網路位置」擋下）────────────────
// 台灣是 Gemini API 的支援地區，但這支 Worker 是在「離用戶最近的 Cloudflare 節點」
// 執行，請求也從那個節點送出——台灣用戶若被路由到香港等不支援地區的節點，Google 就會
// 回 400 FAILED_PRECONDITION「User location is not supported for the API use.」。
// 用戶完全無從得知，只會以為是自己額度用完。這裡負責：(1) 標記給前端翻成人話、
// (2) 通知站長並附上實際節點，才有辦法判斷要不要改用固定地區的出口。
function isGeoBlocked(data) {
  const m = (data && data.error && data.error.message) || '';
  return /location is not supported/i.test(String(m));
}
// 同一個節點被擋時每小時最多通知一次，避免洗版（KV 的 TTL 最小值為 60 秒）
async function alertGeoBlock(env, colo, country) {
  const k = 'alert:geo:' + colo;
  if (await env.TAROT_KV.get(k)) return;
  await env.TAROT_KV.put(k, '1', { expirationTtl: 60 * 60 });
  await sendTelegram(env,
    `🌏 AI 解牌被 Google 依地區擋下\n節點：${colo}（用戶所在地：${country}）\n` +
    `這台節點送出的請求不被 Gemini API 接受，該節點的用戶會解不了牌。\n` +
    `用戶端已顯示「換個網路再試」的說明。若持續發生，需要把 Worker 固定在支援地區出口。`);
}

// ── 定期驗證：用戶路徑的出口是否仍在支援地區 ────────────────────
// [placement] 只作用於 fetch handler，Cron 自己跑在哪個節點不受控——所以不能用「這次
// Cron 的出口」來判斷用戶有沒有問題，要去打自己的 /version（那是 fetch handler，受
// placement 控制），拿到的才是用戶請求真正的出口。
// 只在「狀態改變」時通知，平常完全安靜。
async function checkEgressRegion(env) {
  const EK = 'health:egress';
  let country = '?', colo = '?';
  try {
    const r = await fetch(WORKER_PUBLIC_URL + '/version', { headers: { 'Origin': ALLOWED_ORIGINS[0] } });
    const d = await r.json();
    country = d.egressCountry || '?';
    colo = d.egressColo || '?';
  } catch (e) {
    return; // 連自己都打不到就別亂報，下一輪再說
  }
  const bad = UNSUPPORTED_REGIONS.includes(country);
  const prev = JSON.parse((await env.TAROT_KV.get(EK)) || '{}');
  if (prev.country === country) return; // 沒變就不吵
  await env.TAROT_KV.put(EK, JSON.stringify({ country, colo, at: new Date().toISOString() }));
  if (bad) {
    await sendTelegram(env,
      `🚨 AI 解牌的出口落在不支援地區：${country}（節點 ${colo}）\n` +
      `用戶會開始遇到「User location is not supported」。\n` +
      `請確認 wrangler.toml 的 [placement] region 還在，以及最後一次部署是否成功。`);
  } else if (prev.country && UNSUPPORTED_REGIONS.includes(prev.country)) {
    await sendTelegram(env, `✅ AI 解牌的出口已回到支援地區：${country}（節點 ${colo}）`);
  }
}

// ── 定期健康檢查：主動偵測 Gemini API 是否還能正常呼叫 ──────────
// 由 wrangler.toml 的 Cron Trigger 每 6 小時自動呼叫一次（見下方 scheduled()），
// 也可透過 GET /health 手動立即檢查一次。這是這次「gemini-flash-latest 被下架
// 導致全站中斷卻沒人發現」事故後加的：一旦 Google 又更新/棄用模型，
// 不用等用戶回報才知道，會直接收到 Telegram 通知。
// KV 記錄目前狀態，避免同一次中斷每 6 小時就再推播一次騷擾——只在「狀態改變」
// （正常→異常、異常→恢復）時才通知。
async function checkGeminiHealth(env) {
  const HK = 'health:gemini';
  let ok = false, errMsg = '';
  try {
    const { resp, data } = await fetchGeminiWithFallback(env.GEMINI_KEY, { contents: [{ parts: [{ text: 'ping' }] }] });
    ok = resp.ok && !data.error && !!(data.candidates && data.candidates.length);
    if (!ok) errMsg = (data && data.error && data.error.message) || `HTTP ${resp.status}`;
  } catch (e) {
    errMsg = (e && e.message) || String(e);
  }

  const prev = JSON.parse((await env.TAROT_KV.get(HK)) || '{"ok":true}');
  const now = new Date().toISOString();

  if (ok) {
    if (prev.ok === false) { // 剛從異常恢復
      await sendTelegram(env, `✅ AI 解牌已恢復正常\n中斷期間：${prev.since || '未知'} ～ ${now}\n（模型：${GEMINI_MODEL}）`);
    }
    await env.TAROT_KV.put(HK, JSON.stringify({ ok: true, lastOk: now }));
  } else {
    // 沒有中繼（本機／綁定遺失）時 Cron 跑在哪不受控，被地區擋不代表用戶被擋；有中繼就是真的異常、照常通知
    if (!geminiNs && /location is not supported/i.test(errMsg)) return { ok, errMsg, checkedAt: now, skipped: 'geo' };
    if (prev.ok !== false) { // 剛從正常變異常，第一次偵測到才通知（避免每 6 小時重複騷擾）
      await sendTelegram(env, `🚨 AI 解牌可能已中斷！\n嘗試過的模型：${[GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS].join('、')}（全部失敗）\n錯誤：${errMsg}\n請到 https://ai.google.dev/gemini-api/docs/models 確認目前可用的模型名稱，更新 worker.js 的 GEMINI_MODEL 常數。`);
    }
    await env.TAROT_KV.put(HK, JSON.stringify({ ok: false, since: prev.ok === false ? prev.since : now, lastCheck: now, lastError: errMsg }));
  }
  return { ok, errMsg, checkedAt: now };
}

// ── Gemini proxy ─────────────────────────────────────────────
// ── 版本 / 執行位置 ────────────────────────────────────────────
// cdn-cgi/trace 由「實際執行這段程式的節點」回應，拿到的是這支 Worker 的出口
// （request.cf.colo 是用戶進來的節點）。Gemini 改走美國中繼後，這不再是 Google 看到的出口。
async function egressInfo() {
  const out = { colo: '?', country: '?' };
  try {
    const t = await fetch('https://cloudflare.com/cdn-cgi/trace');
    const txt = await t.text();
    const c = txt.match(/^colo=(.+)$/m); if (c) out.colo = c[1].trim();
    const l = txt.match(/^loc=(.+)$/m); if (l) out.country = l[1].trim();
  } catch (e) {}
  return out;
}

async function handleVersion(request, env) {
  const eg = await egressInfo();
  const egressColo = eg.colo;
  return json({
    version: WORKER_VERSION,
    // 以下 egress* 是「這支 Worker 自己」的出口；Gemini 走美國中繼後，Google 看到的是 DO 的美國出口，
    // 所以 Gemini 會不會被擋請看 geminiViaUS／geminiEgressOk，egressOk 只當參考
    egressColo,
    egressCountry: eg.country,
    egressOk: !UNSUPPORTED_REGIONS.includes(eg.country),
    geminiViaUS: !!geminiNs,                           // Gemini 走美國中繼（DO, us jurisdiction 硬限制）
    geminiEgressOk: !!geminiNs || !UNSUPPORTED_REGIONS.includes(eg.country),
    ingressColo: (request.cf && request.cf.colo) || '?', // 用戶連進來的節點
    country: (request.cf && request.cf.country) || '?',
    model: GEMINI_MODEL,
  }, 200, request);
}

// ── 自備 API Key 的代轉 ────────────────────────────────────────
// 自備 key 的用戶是瀏覽器直連 Google，出口就是他自己的網路位置；若他開了 VPN／
// iCloud 私密轉送、或當地出口不被 Gemini 接受，就會被擋，前端無計可施。
// Gemini 請求一律經美國中繼（GeminiProxy，us jurisdiction）送出，所以改由它代轉
// 就能繞過。用的是用戶自己的 key、不碰本站額度與點數；限本站來源，避免變成公開代理。
async function handleGeminiRelay(request, env) {
  const origin = request.headers.get('Origin');
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'forbidden' }, 403, request);
  const { key, body: geminiBody } = await request.json().catch(() => ({}));
  if (!key || !geminiBody) return json({ error: '缺少 API Key 或請求內容' }, 400, request);
  const { resp, data } = await fetchGeminiWithFallback(String(key).slice(0, 200), geminiBody);
  return json(data, resp.status, request);
}

async function handleGemini(request, env) {
  // 暫停付費 AI 解牌（配額已滿）：直接回覆暫停訊息，不呼叫 Gemini，停止消耗配額
  if (AI_PAUSED) {
    return json({ error: 'AI 解牌暫停服務：API 配額已滿，請稍後再試 / AI readings are paused: quota reached, please try again later.', paused: true }, 503, request);
  }

  const { body: geminiBody, spend } = await request.json().catch(() => ({}));

  // 身分看 session token（/auth/verify 發的），body 裡的 email 不再採信
  const s = await requirePaidSession(request, env);
  if (s.error) return s.error;
  const e = s.email;

  if (!geminiBody) return json({ error: '缺少請求內容' }, 400, request);

  // Credit 扣點模式：超出免費額度的呼叫（追問超過每次上限 / 當日次數用完）。
  // 有餘額 → 略過每日上限檢查，成功後才扣 1 點；無餘額 → 402。
  const ck = `credits:${e}`;
  let creditBalance = null;
  if (spend) {
    creditBalance = parseInt((await env.TAROT_KV.get(ck)) || '0', 10);
    if (creditBalance < 1) {
      return json({ error: 'Credit 點數不足 / Not enough credits', noCredits: true, balance: 0 }, 402, request);
    }
  }

  // 全站成本總閘（扣點呼叫已付費，不受總閘限制）
  const dk = todayKey();
  const used = parseInt((await env.TAROT_KV.get(dk)) || '0', 10);
  if (!spend && used >= DAILY_CAP) {
    return json({ error: '今日 AI 解牌已額滿，請明天再來 / Today\'s AI readings are full, please try again tomorrow.', capped: true }, 429, request);
  }
  // 單一用戶每日上限（防狂刷；扣點呼叫不受限）
  const uk = userDayKey(e);
  const uUsed = parseInt((await env.TAROT_KV.get(uk)) || '0', 10);
  if (!spend && uUsed >= USER_DAILY_CAP) {
    const bal = parseInt((await env.TAROT_KV.get(ck)) || '0', 10);
    return json({ error: `你今天的 AI 解牌已達上限（${USER_DAILY_CAP} 次），明天會重置；想立即使用可在設定改用自己的 API Key。/ You've reached today's AI reading limit (${USER_DAILY_CAP}); it resets tomorrow. You can use your own API key to continue now.`, capped: true, userCapped: true, balance: bal }, 429, request);
  }

  const { resp, data } = await fetchGeminiWithFallback(env.GEMINI_KEY, geminiBody);
  // 被 Google 依地區擋下：不扣額度也不扣點（下面的 resp.ok 判斷已涵蓋），
  // 另外通知站長並標記，讓前端能翻成「跟你的額度無關，換個網路再試」
  if (isGeoBlocked(data)) {
    const colo = (request.cf && request.cf.colo) || '?';
    const country = (request.cf && request.cf.country) || '?';
    await alertGeoBlock(env, colo, country);
    return json({ ...data, __geoBlocked: true, __colo: colo }, resp.status, request);
  }
  // 只在「成功」時才計入用量與扣點（失敗 / 重試不浪費額度與點數）
  if (resp.ok && !data.error && spend) {
    const balNow = Math.max(0, parseInt((await env.TAROT_KV.get(ck)) || '0', 10) - 1);
    await env.TAROT_KV.put(ck, String(balNow));
    data.__creditBalance = balNow; // 讓前端即時更新餘額顯示
  }
  if (resp.ok && !data.error) {
    await env.TAROT_KV.put(dk, String(used + 1), { expirationTtl: 60 * 60 * 24 * 3 });
    await env.TAROT_KV.put(uk, String(uUsed + 1), { expirationTtl: 60 * 60 * 24 * 2 });
  }
  return json(data, resp.status, request);
}
