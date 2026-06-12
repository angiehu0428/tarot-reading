// Tarot Reading — Cloudflare Worker
// KV namespace: TAROT_KV
// Env vars: GEMINI_KEY, GUMROAD_SELLER_ID

const ALLOWED_ORIGIN = 'https://angiehu0428.github.io';

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
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

    return new Response('Not found', { status: 404 });
  },
};

// ── Gumroad webhook ──────────────────────────────────────────
async function handleWebhook(request, env) {
  const text = await request.text();
  const params = new URLSearchParams(text);

  const sellerId = params.get('seller_id');
  console.log('webhook ping: seller_id=' + sellerId); // TEMP: capture seller id during setup
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
  if (!email) return json({ verified: false });

  const record = await env.TAROT_KV.get(`email:${email.toLowerCase().trim()}`);
  return json({ verified: !!record });
}

// ── Gemini proxy ─────────────────────────────────────────────
async function handleGemini(request, env) {
  const { email, body: geminiBody } = await request.json().catch(() => ({}));

  if (!email) return json({ error: '請提供 email' }, 400);

  const record = await env.TAROT_KV.get(`email:${email.toLowerCase().trim()}`);
  if (!record) {
    return json({ error: '此 email 尚未驗證付款。請確認使用 Gumroad 購買時的 email。' }, 403);
  }

  if (!geminiBody) return json({ error: '缺少請求內容' }, 400);

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
  return json(data, resp.status);
}
