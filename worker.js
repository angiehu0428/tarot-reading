// Tarot Reading — Cloudflare Worker
// KV namespace: TAROT_KV
// Env vars: GEMINI_KEY, GUMROAD_SELLER_ID, STATS_TOKEN

// 每日 AI 解牌上限（成本煞車）。超過就暫停當天的 AI 解牌。
const DAILY_CAP = 300;
function todayKey() { return 'count:' + new Date().toISOString().slice(0, 10); }

const ALLOWED_ORIGINS = [
  'https://angiehu0428.github.io',
  'https://tarot.angiehu.com',
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

    return new Response('Not found', { status: 404 });
  },
};

// ── Gumroad webhook ──────────────────────────────────────────
async function handleWebhook(request, env) {
  const text = await request.text();
  const params = new URLSearchParams(text);

  const sellerId = params.get('seller_id');
  const email = params.get('email')?.toLowerCase().trim();
  const saleId = params.get('sale_id') || '';
  const refunded = params.get('refunded') === 'true';

  // Verify this is from your Gumroad account
  if (!env.GUMROAD_SELLER_ID || sellerId !== env.GUMROAD_SELLER_ID) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (!email) return new Response('No email', { status: 400 });

  if (refunded) {
    // Remove access on refund
    await env.TAROT_KV.delete(`email:${email}`);
  } else {
    await env.TAROT_KV.put(
      `email:${email}`,
      JSON.stringify({ verified: true, date: new Date().toISOString(), saleId }),
      { expirationTtl: 60 * 60 * 24 * 730 } // 2 years
    );
  }

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
  return json({ dailyCap: DAILY_CAP, today: days[0], last7days: days }, 200, request);
}

// ── Gemini proxy ─────────────────────────────────────────────
async function handleGemini(request, env) {
  const { email, body: geminiBody } = await request.json().catch(() => ({}));

  if (!email) return json({ error: '請提供 email' }, 400, request);

  const record = await env.TAROT_KV.get(`email:${email.toLowerCase().trim()}`);
  if (!record) {
    return json({ error: '此 email 尚未驗證付款。請確認使用 Gumroad 購買時的 email。' }, 403, request);
  }

  if (!geminiBody) return json({ error: '缺少請求內容' }, 400, request);

  // 成本煞車：超過每日上限就暫停，當天用戶改用內建解讀
  const dk = todayKey();
  const used = parseInt((await env.TAROT_KV.get(dk)) || '0', 10);
  if (used >= DAILY_CAP) {
    return json({ error: '今日 AI 解牌已額滿，請明天再來 / Today\'s AI readings are full, please try again tomorrow.', capped: true }, 429, request);
  }
  // 計入今日用量（3 天後自動過期）
  await env.TAROT_KV.put(dk, String(used + 1), { expirationTtl: 60 * 60 * 24 * 3 });

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
  return json(data, resp.status, request);
}
