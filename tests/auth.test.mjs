// 登入／session 的回歸測試（純 Node，不碰網路、不碰真 KV）
// 跑法：cd /Users/angiehu/Claude/tarot && node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const W = 'https://tarot-worker.test';
const PAID = 'paid@example.com';
const SALE = 'sale_abc123==';

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

// 攔截 worker 往外打的 fetch：Resend 收驗證碼、Telegram 收通知、Gemini 回假解讀
function fakeNet() {
  const sent = { emails: [], telegram: [], gemini: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) {
      sent.emails.push(JSON.parse(init.body));
      return new Response('{"id":"x"}', { status: 200 });
    }
    if (u.includes('api.telegram.org')) {
      sent.telegram.push(JSON.parse(init.body).text);
      return new Response('{}', { status: 200 });
    }
    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
      sent.gemini++;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  return sent;
}

function env(kv, extra = {}) {
  return { TAROT_KV: kv, GEMINI_KEY: 'g', RESEND_API_KEY: 'r', EMAIL_FROM: 'Tarot <no-reply@example.com>', ...extra };
}
async function seedPaid(kv, email = PAID) {
  await kv.put(`email:${email}`, JSON.stringify({ verified: true, saleId: SALE, plan: 'lifetime' }));
}
async function call(e, path, body, token) {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://tarot.angiehu.com' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request(W + path, { method: 'POST', headers, body: JSON.stringify(body || {}) }), e);
  return { status: res.status, data: await res.json().catch(() => ({})), res };
}
function codeFrom(email) { return /(\d{6})/.exec(email.subject)[1]; }
async function login(e, net, email = PAID) {
  const s = await call(e, '/auth/start', { email });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const v = await call(e, '/auth/verify', { email, code: codeFrom(net.emails.at(-1)) });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return v.data.token;
}

test('只知道付費者 email 再也拿不到東西：/sync、/credits、/gemini 沒 token 一律 401', async () => {
  const kv = fakeKV(); fakeNet(); const e = env(kv);
  await seedPaid(kv);
  await kv.put(`hist:${PAID}`, JSON.stringify({ readings: [{ id: 1, q: 'secret' }], full: [] }));
  for (const [path, body] of [
    ['/sync', { email: PAID, action: 'pull' }],
    ['/sync', { email: PAID, action: 'push', readings: [] }],
    ['/credits', { email: PAID }],
    ['/gemini', { email: PAID, body: { contents: [] } }],
  ]) {
    const r = await call(e, path, body);
    assert.equal(r.status, 401, path);
    assert.equal(r.data.needLogin, true, path);
  }
  // 雲端記錄沒被清空
  assert.match(kv.m.get(`hist:${PAID}`), /secret/);
});

test('/check 不再是「這個 email 有沒有付費」的查詢機', async () => {
  const kv = fakeKV(); fakeNet(); const e = env(kv);
  await seedPaid(kv);
  const r = await call(e, '/check', { email: PAID });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { verified: false, needLogin: true });
  const r2 = await call(e, '/check', { email: 'nobody@example.com' });
  assert.deepEqual(r2.data, { verified: false, needLogin: true });
});

test('驗證碼登入：寄碼 → 錯碼被擋 → 對碼拿 token → 付費端點通', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  // 沒付費的 email 不寄
  assert.equal((await call(e, '/auth/start', { email: 'nobody@example.com' })).status, 404);
  assert.equal(net.emails.length, 0);
  // 付費的寄到正確信箱，信裡有 6 位數
  const s = await call(e, '/auth/start', { email: ' Paid@Example.com ' });
  assert.equal(s.status, 200); assert.equal(s.data.via, 'email');
  assert.deepEqual(net.emails[0].to, [PAID]);
  const code = codeFrom(net.emails[0]);
  assert.match(net.emails[0].text, new RegExp(code));
  // 60 秒內重寄不會再寄一封
  const again = await call(e, '/auth/start', { email: PAID });
  assert.equal(again.data.cooldown, true); assert.equal(net.emails.length, 1);
  // 錯碼
  const wrong = await call(e, '/auth/verify', { email: PAID, code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 401); assert.equal(wrong.data.wrong, true); assert.equal(wrong.data.left, 4);
  // 對碼
  const ok = await call(e, '/auth/verify', { email: PAID, code });
  assert.equal(ok.status, 200); assert.match(ok.data.token, /^[a-f0-9]{64}$/); assert.equal(ok.data.email, PAID);
  // 同一組碼不能用第二次
  assert.equal((await call(e, '/auth/verify', { email: PAID, code })).status, 401);
  const tok = ok.data.token;
  // 付費端點通；body 裡塞別人的 email 也以 token 為準
  const push = await call(e, '/sync', { email: 'victim@example.com', action: 'push', readings: [{ id: 1 }], full: [], projects: [] }, tok);
  assert.equal(push.status, 200);
  assert.ok(kv.m.has(`hist:${PAID}`)); assert.ok(!kv.m.has('hist:victim@example.com'));
  const pull = await call(e, '/sync', { action: 'pull' }, tok);
  assert.equal(pull.data.readings.length, 1);
  await kv.put(`credits:${PAID}`, '7');
  assert.equal((await call(e, '/credits', {}, tok)).data.balance, 7);
  const g = await call(e, '/gemini', { body: { contents: [{ parts: [{ text: 'hi' }] }] } }, tok);
  assert.equal(g.status, 200); assert.equal(net.gemini, 1);
  assert.equal(kv.m.get(`ucount:${PAID}:${new Date().toISOString().slice(0, 10)}`), '1');
  // 扣點走 token 的 email
  const g2 = await call(e, '/gemini', { body: { contents: [] }, spend: true }, tok);
  assert.equal(g2.data.__creditBalance, 6);
  // /check 帶 token → 仍付費
  assert.deepEqual((await call(e, '/check', {}, tok)).data, { verified: true, email: PAID });
  // 假 token 不通
  assert.equal((await call(e, '/sync', { action: 'pull' }, 'f'.repeat(64))).status, 401);
  // 登出後 token 作廢
  assert.equal((await call(e, '/auth/logout', {}, tok)).status, 200);
  assert.equal((await call(e, '/sync', { action: 'pull' }, tok)).status, 401);
});

test('錯 5 次驗證碼就作廢，要重寄', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  await call(e, '/auth/start', { email: PAID });
  const code = codeFrom(net.emails[0]);
  const bad = code === '999999' ? '000000' : '999999';
  let last;
  for (let i = 0; i < 5; i++) last = await call(e, '/auth/verify', { email: PAID, code: bad });
  assert.equal(last.data.expired, true);
  assert.equal((await call(e, '/auth/verify', { email: PAID, code })).status, 401); // 對的碼也沒用了
});

test('訂閱到期（付費記錄被 webhook 刪掉）→ token 還在但端點回 403，不是 401', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  const tok = await login(e, net);
  await kv.delete(`email:${PAID}`);
  const r = await call(e, '/sync', { action: 'pull' }, tok);
  assert.equal(r.status, 403); assert.equal(r.data.notPaid, true);
  assert.deepEqual((await call(e, '/check', {}, tok)).data, { verified: false, email: PAID });
});

test('Gumroad 購後轉址：sale_id 對得上才直接發 token', async () => {
  const kv = fakeKV(); fakeNet(); const e = env(kv);
  await seedPaid(kv);
  const bad = await call(e, '/check', { email: PAID, sale_id: 'guess' });
  assert.deepEqual(bad.data, { verified: false, needLogin: true });
  const good = await call(e, '/check', { email: PAID, sale_id: SALE });
  assert.equal(good.data.verified, true); assert.match(good.data.token, /^[a-f0-9]{64}$/);
  assert.equal((await call(e, '/sync', { action: 'pull' }, good.data.token)).status, 200);
});

test('同一個 IP 一小時內狂打 /auth/start 會被擋', async () => {
  const kv = fakeKV(); fakeNet(); const e = env(kv);
  await seedPaid(kv);
  let last;
  for (let i = 0; i < 21; i++) {
    const res = await worker.fetch(new Request(W + '/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ email: `u${i}@example.com` }) }), e);
    last = { status: res.status, data: await res.json() };
  }
  assert.equal(last.status, 429); assert.equal(last.data.rateLimited, true);
});

test('沒設 Resend 時：有 Telegram 就把碼丟給站長手動轉（via manual），都沒有就 503', async () => {
  const kv = fakeKV(); const net = fakeNet();
  await seedPaid(kv);
  const r = await call(env(kv, { RESEND_API_KEY: undefined, EMAIL_FROM: undefined, TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' }), '/auth/start', { email: PAID });
  assert.equal(r.status, 200); assert.equal(r.data.via, 'manual');
  assert.equal(net.emails.length, 0); assert.match(net.telegram[0], /\d{6}/);
  const kv2 = fakeKV(); await seedPaid(kv2);
  const r2 = await call(env(kv2, { RESEND_API_KEY: undefined, EMAIL_FROM: undefined }), '/auth/start', { email: PAID });
  assert.equal(r2.status, 503); assert.equal(r2.data.mailFailed, true);
});

test('CORS 預檢放行 Authorization header', async () => {
  const res = await worker.fetch(new Request(W + '/sync', { method: 'OPTIONS', headers: { Origin: 'https://tarot.angiehu.com' } }), env(fakeKV()));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});
