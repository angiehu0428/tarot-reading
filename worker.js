// Tarot Reading — Cloudflare Worker
// KV namespace: TAROT_KV
// Env vars: GEMINI_KEY, GUMROAD_SELLER_ID, STATS_TOKEN

// 全站每日 AI 解牌上限（成本總閘）。想再高/再低就改這個數字。
const DAILY_CAP = 2000;
// 每位付費用戶每日上限（防單一用戶狂刷成本）。30 次對正常使用很夠，可自行調整。
const USER_DAILY_CAP = 30;
function userDayKey(email) { return 'ucount:' + email + ':' + new Date().toISOString().slice(0, 10); }
// 付費 AI 解牌暫停開關（API 配額已滿時設 true；恢復服務時改回 false 並重新部署）
const AI_PAUSED = false;
function todayKey() { return 'count:' + new Date().toISOString().slice(0, 10); }

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
    'Access-Control-Allow-Headers': 'Content-Type',
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

    // Email check — lets frontend show "already purchased" state on load
    if (url.pathname === '/check' && request.method === 'POST') {
      return handleCheck(request, env);
    }

    // History sync — paid users sync reading history across devices
    if (url.pathname === '/sync' && request.method === 'POST') {
      return handleSync(request, env);
    }

    // Usage stats — private, view AI-reading counts (key in query)
    if (url.pathname === '/stats' && request.method === 'GET') {
      return handleStats(request, env);
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

    return new Response('Not found', { status: 404 });
  },
};

// ── Report / feature wish ────────────────────────────────────
async function handleReport(request, env) {
  const { type, message, contact, ctx, lang, ua, site } = await request.json().catch(() => ({}));
  const msg = (message || '').toString().trim().slice(0, 2000);
  if (!msg) return json({ error: 'empty' }, 400, request);
  const id = Date.now();
  const rec = {
    id,
    date: new Date().toISOString(),
    type: type === 'wish' ? 'wish' : 'issue',
    message: msg,
    contact: (contact || '').toString().trim().slice(0, 120),
    ctx: (ctx || '').toString().slice(0, 40),
    lang: (lang || '').toString().slice(0, 8),
    ua: (ua || '').toString().slice(0, 200),
    site: (site || 'tarot').toString().slice(0, 20), // which site the report came from
  };
  await env.TAROT_KV.put('report:' + id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 365 });
  // Telegram 即時通知：設定 TG_BOT_TOKEN + TG_CHAT_ID 兩個 secret 才啟用；
  // 通知失敗不影響回報本身（KV 已存檔，/reports 一樣看得到）。
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    const tgText = `${rec.type === 'wish' ? '💡 功能許願' : '🐞 問題回報'}（${rec.site}）\n\n${rec.message}` +
      (rec.contact ? `\n\n↩ 聯絡方式：${rec.contact}` : '') +
      `\n🌐 ${rec.lang || '?'}${rec.ctx ? ' · ' + rec.ctx : ''}`;
    try {
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: tgText.slice(0, 3800) }),
      });
    } catch (e) {}
  }
  return json({ ok: true }, 200, request);
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
    return `<div class="card ${isWish ? 'wish' : 'issue'}" data-id="${r.id}">
      <button class="del" onclick="delReport(this)" title="刪除這筆回報">✕</button>
      <div class="meta"><span class="tag">${isWish ? '💡 許願' : '🐞 問題'}</span><span class="site">${esc(r.site || 'tarot')}</span><span class="date">${new Date(r.date).toLocaleString('zh-TW')}</span>${r.ctx ? `<span class="ctx">${esc(r.ctx)}</span>` : ''}<span class="lang">${esc(r.lang)}</span></div>
      <div class="msg">${esc(r.message)}</div>
      ${r.contact ? `<div class="contact">↩ ${esc(r.contact)}</div>` : ''}
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
  .meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:.74rem;color:#9a8db5;margin-bottom:8px}
  .tag{color:#f0d878;font-weight:700}
  .card.wish .tag{color:#9ec5ff}
  .ctx,.lang{background:rgba(255,255,255,.06);border-radius:4px;padding:1px 6px}
  .site{background:rgba(120,180,255,.14);color:#9ec5ff;border-radius:4px;padding:1px 7px;font-weight:700;letter-spacing:.04em}
  .msg{color:#efe9ff;font-size:.95rem;white-space:pre-wrap;line-height:1.7}
  .contact{margin-top:8px;color:#d4af37;font-size:.82rem}
  .ua{margin-top:6px;color:#5a4d75;font-size:.66rem;word-break:break-all}
  .empty{text-align:center;color:#6a5d85;padding:40px}
</style></head><body><div class="wrap">
  <h1>✦ 用戶回報 ✦</h1>
  <div class="sub">塔羅神諭 · 🐞 問題 ${issues} 件 · 💡 許願 ${wishes} 件</div>
  ${rows || '<div class="empty">目前還沒有任何回報</div>'}
</div>
<script>
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

  return new Response('OK');
}

// ── Check if email is verified ───────────────────────────────
async function handleCheck(request, env) {
  const { email } = await request.json().catch(() => ({}));
  if (!email) return json({ verified: false }, 200, request);

  const record = await env.TAROT_KV.get(`email:${email.toLowerCase().trim()}`);
  return json({ verified: !!record }, 200, request);
}

// ── History sync (paid users only) ───────────────────────────
async function handleSync(request, env) {
  const { email, action, readings, full } = await request.json().catch(() => ({}));
  const e = email && email.toLowerCase().trim();
  if (!e) return json({ error: 'no email' }, 400, request);

  // Only verified (paid) emails may sync
  const record = await env.TAROT_KV.get(`email:${e}`);
  if (!record) return json({ error: 'email not verified' }, 403, request);

  const key = `hist:${e}`;
  if (action === 'pull') {
    const stored = await env.TAROT_KV.get(key);
    return json(stored ? JSON.parse(stored) : { readings: [], full: [] }, 200, request);
  }
  if (action === 'push') {
    const payload = JSON.stringify({
      readings: Array.isArray(readings) ? readings.slice(0, 60) : [],
      full: Array.isArray(full) ? full.slice(0, 60) : [],
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

// ── Gemini proxy ─────────────────────────────────────────────
async function handleGemini(request, env) {
  // 暫停付費 AI 解牌（配額已滿）：直接回覆暫停訊息，不呼叫 Gemini，停止消耗配額
  if (AI_PAUSED) {
    return json({ error: 'AI 解牌暫停服務：API 配額已滿，請稍後再試 / AI readings are paused: quota reached, please try again later.', paused: true }, 503, request);
  }

  const { email, body: geminiBody } = await request.json().catch(() => ({}));

  if (!email) return json({ error: '請提供 email' }, 400, request);

  const e = email.toLowerCase().trim();
  const record = await env.TAROT_KV.get(`email:${e}`);
  if (!record) {
    return json({ error: '此 email 尚未驗證付款。請確認使用 Gumroad 購買時的 email。' }, 403, request);
  }

  if (!geminiBody) return json({ error: '缺少請求內容' }, 400, request);

  // 全站成本總閘
  const dk = todayKey();
  const used = parseInt((await env.TAROT_KV.get(dk)) || '0', 10);
  if (used >= DAILY_CAP) {
    return json({ error: '今日 AI 解牌已額滿，請明天再來 / Today\'s AI readings are full, please try again tomorrow.', capped: true }, 429, request);
  }
  // 單一用戶每日上限（防狂刷）
  const uk = userDayKey(e);
  const uUsed = parseInt((await env.TAROT_KV.get(uk)) || '0', 10);
  if (uUsed >= USER_DAILY_CAP) {
    return json({ error: `你今天的 AI 解牌已達上限（${USER_DAILY_CAP} 次），明天會重置；想立即使用可在設定改用自己的 API Key。/ You've reached today's AI reading limit (${USER_DAILY_CAP}); it resets tomorrow. You can use your own API key to continue now.`, capped: true, userCapped: true }, 429, request);
  }

  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_KEY,
      },
      body: JSON.stringify(geminiBody),
    }
  );

  const data = await resp.json();
  // 只在「成功」時才計入用量（失敗 / 重試不浪費額度，數字也更貼近真實成本）
  if (resp.ok && !data.error) {
    await env.TAROT_KV.put(dk, String(used + 1), { expirationTtl: 60 * 60 * 24 * 3 });
    await env.TAROT_KV.put(uk, String(uUsed + 1), { expirationTtl: 60 * 60 * 24 * 2 });
  }
  return json(data, resp.status, request);
}
