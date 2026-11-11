// 登入／session 的回歸測試（純 Node，不碰網路、不碰真 KV／DO）
// 跑法：cd /Users/angiehu/Claude/tarot && node --test tests/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { AuthGate } from '../worker.js';

const W = 'https://tarot-worker.test';
const PAID = 'paid@example.com';
const SALE = 'sale_abc123==';
const SELLER = 'seller_1';

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

// 假的 Durable Object namespace：每個 name 一個 AuthGate 實例，請求照真 DO 的 input gate 一樣逐一排隊；
// storage 每個操作都真的 await（讓沒排隊的版本會交錯），好驗證「同時打進來」的情況
function fakeDO() {
  const objs = new Map();
  return {
    objs,
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objs.has(id.name)) {
        const store = new Map();
        const storage = {
          async get(k) { await new Promise(r => setTimeout(r, 1)); return store.has(k) ? store.get(k) : undefined; },
          async put(k, v) { await new Promise(r => setTimeout(r, 1)); store.set(k, v); },
          async delete(k) { await new Promise(r => setTimeout(r, 1)); (Array.isArray(k) ? k : [k]).forEach(x => store.delete(x)); },
        };
        const inst = new AuthGate({ storage }, {});
        let chain = Promise.resolve();
        objs.set(id.name, {
          store,
          fetch(url, init) { const p = chain.then(() => inst.fetch(new Request(url, init))); chain = p.catch(() => {}); return p; },
        });
      }
      return objs.get(id.name);
    },
  };
}

// 攔截 worker 往外打的 fetch：Resend 收驗證碼、Telegram 收通知、Gemini 回假解讀
function fakeNet(opts = {}) {
  const sent = { emails: [], telegram: [], gemini: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) {
      if (opts.resendFails) return new Response('{"message":"boom"}', { status: 500 });
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
  return { TAROT_KV: kv, AUTH_GATE: fakeDO(), GEMINI_KEY: 'g', GUMROAD_SELLER_ID: SELLER, RESEND_API_KEY: 'r', EMAIL_FROM: 'Tarot <no-reply@example.com>', ...extra };
}
async function seedPaid(kv, email = PAID) {
  await kv.put(`email:${email}`, JSON.stringify({ verified: true, saleId: SALE, plan: 'lifetime' }));
}
async function call(e, path, body, token, ip = '9.9.9.9') {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://tarot.angiehu.com', 'CF-Connecting-IP': ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request(W + path, { method: 'POST', headers, body: JSON.stringify(body || {}) }), e);
  return { status: res.status, data: await res.json().catch(() => ({})), res };
}
function codeFrom(mail) { return /(\d{6})/.exec(mail.subject)[1]; }
function otherCode(code) { return code === '000000' ? '111111' : '000000'; }
async function login(e, net, email = PAID) {
  const s = await call(e, '/auth/start', { email });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const v = await call(e, '/auth/verify', { email, code: codeFrom(net.emails.at(-1)) });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return v.data.token;
}
// 模擬 Gumroad ping（form-encoded）
async function webhook(e, params) {
  const res = await worker.fetch(new Request(W + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ seller_id: SELLER, ...params }).toString() }), e);
  return res.status;
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
  assert.match(kv.m.get(`hist:${PAID}`), /secret/); // 雲端記錄沒被清空
});

test('/check 與 /auth/start 都不透露「這個 email 有沒有付費」', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  assert.deepEqual((await call(e, '/check', { email: PAID })).data, { verified: false, needLogin: true });
  assert.deepEqual((await call(e, '/check', { email: 'nobody@example.com' })).data, { verified: false, needLogin: true });
  const a = await call(e, '/auth/start', { email: PAID });
  const b = await call(e, '/auth/start', { email: 'nobody@example.com' });
  const c = await call(e, '/auth/start', { email: PAID }); // 冷卻中
  assert.equal(a.status, 200); assert.deepEqual(a.data, b.data); assert.deepEqual(a.data, c.data);
  assert.equal(net.emails.length, 1); // 只有付費的那封真的寄、冷卻中不重寄
  assert.deepEqual(net.emails[0].to, [PAID]);
});

test('驗證碼登入：寄碼 → 錯碼被擋 → 對碼拿 token → 付費端點通（email 以 token 為準）', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  const s = await call(e, '/auth/start', { email: ' Paid@Example.com ' });
  assert.equal(s.status, 200);
  const code = codeFrom(net.emails[0]);
  assert.match(net.emails[0].text, new RegExp(code));
  const wrong = await call(e, '/auth/verify', { email: PAID, code: otherCode(code) });
  assert.equal(wrong.status, 401); assert.equal(wrong.data.wrong, true); assert.equal(wrong.data.left, 4);
  const ok = await call(e, '/auth/verify', { email: PAID, code });
  assert.equal(ok.status, 200); assert.match(ok.data.token, /^[a-f0-9]{64}$/); assert.equal(ok.data.email, PAID);
  assert.equal((await call(e, '/auth/verify', { email: PAID, code })).status, 401); // 同一組碼不能用第二次
  const tok = ok.data.token;
  const push = await call(e, '/sync', { email: 'victim@example.com', action: 'push', readings: [{ id: 1 }], full: [], projects: [] }, tok);
  assert.equal(push.status, 200);
  assert.ok(kv.m.has(`hist:${PAID}`)); assert.ok(!kv.m.has('hist:victim@example.com'));
  assert.equal((await call(e, '/sync', { action: 'pull' }, tok)).data.readings.length, 1);
  await kv.put(`credits:${PAID}`, '7');
  assert.equal((await call(e, '/credits', {}, tok)).data.balance, 7);
  const g = await call(e, '/gemini', { body: { contents: [{ parts: [{ text: 'hi' }] }] } }, tok);
  assert.equal(g.status, 200); assert.equal(net.gemini, 1);
  assert.equal(kv.m.get(`ucount:${PAID}:${new Date().toISOString().slice(0, 10)}`), '1');
  assert.equal((await call(e, '/gemini', { body: { contents: [] }, spend: true }, tok)).data.__creditBalance, 6);
  assert.deepEqual((await call(e, '/check', {}, tok)).data, { verified: true, email: PAID });
  assert.equal((await call(e, '/sync', { action: 'pull' }, 'f'.repeat(64))).status, 401); // 假 token
  assert.equal((await call(e, '/auth/logout', {}, tok)).status, 200);
  assert.equal((await call(e, '/sync', { action: 'pull' }, tok)).status, 401); // 登出後作廢
});

test('同時打 5 個錯碼：tries 正好算到 5、碼作廢，之後對的碼也沒用', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  await call(e, '/auth/start', { email: PAID });
  const code = codeFrom(net.emails[0]);
  const rs = await Promise.all([0, 1, 2, 3, 4].map(() => call(e, '/auth/verify', { email: PAID, code: otherCode(code) })));
  const lefts = rs.map(r => r.data.left).filter(x => x != null).sort();
  assert.deepEqual(lefts, [1, 2, 3, 4]);              // 四次 wrong，left 各不相同（沒互相蓋掉）
  assert.equal(rs.filter(r => r.data.expired).length, 1); // 第五次作廢
  assert.equal((await call(e, '/auth/verify', { email: PAID, code })).status, 401);
});

test('對碼與錯碼同時到：對碼只拿到一個 token，錯碼不能讓作廢的碼復活', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  await call(e, '/auth/start', { email: PAID });
  const code = codeFrom(net.emails[0]);
  const rs = await Promise.all([
    call(e, '/auth/verify', { email: PAID, code: otherCode(code) }),
    call(e, '/auth/verify', { email: PAID, code }),
    call(e, '/auth/verify', { email: PAID, code: otherCode(code) }),
    call(e, '/auth/verify', { email: PAID, code }),
  ]);
  assert.equal(rs.filter(r => r.status === 200 && r.data.token).length, 1); // 重放只成功一次
  assert.equal((await call(e, '/auth/verify', { email: PAID, code })).status, 401);
  const obj = e.AUTH_GATE.objs.get(`email:${PAID}`);
  assert.equal(obj.store.has('otp'), false); // 錯碼晚到也沒把 otp 寫回去
});

test('錯 5 次驗證碼就作廢；同一個 email 10 分鐘內猜超過 10 次直接 429', async () => {
  const kv = fakeKV(); const net = fakeNet(); const e = env(kv);
  await seedPaid(kv);
  await call(e, '/auth/start', { email: PAID });
  const code = codeFrom(net.emails[0]);
  let last;
  for (let i = 0; i < 5; i++) last = await call(e, '/auth/verify', { email: PAID, code: otherCode(code) });
  assert.equal(last.data.expired, true);
  assert.equal((await call(e, '/auth/verify', { email: PAID, code })).status, 401); // 對的碼也沒用了
  // 第 6～10 次 expired，第 11 次起限流（跟有沒有新碼無關，換 IP 也一樣）
  for (let i = 0; i < 4; i++) await call(e, '/auth/verify', { email: PAID, code }, undefined, `1.1.1.${i}`);
  const r11 = await call(e, '/auth/verify', { email: PAID, code }, undefined, '2.2.2.2');
  assert.equal(r11.status, 429); assert.equal(r11.data.rateLimited, true);
});

test('信寄失敗：不回 sent、冷卻撤銷可以馬上重試；沒設寄信 → 503 叫用戶聯絡站長、碼不外流', async () => {
  const kv = fakeKV(); fakeNet({ resendFails: true }); const e = env(kv, { TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' });
  await seedPaid(kv);
  const r = await call(e, '/auth/start', { email: PAID });
  assert.equal(r.status, 503); assert.equal(r.data.mailFailed, true); assert.notEqual(r.data.sent, true);
  const obj = e.AUTH_GATE.objs.get(`email:${PAID}`);
  assert.equal(obj.store.has('otp'), false); assert.equal(obj.store.has('cooldownUntil'), false);
  // 寄件端恢復 → 不用等冷卻就能再寄
  const net2 = fakeNet();
  const r2 = await call(e, '/auth/start', { email: PAID });
  assert.equal(r2.status, 200); assert.equal(net2.emails.length, 1);
  // 完全沒設寄信
  const kv3 = fakeKV(); await seedPaid(kv3); const net3 = fakeNet();
  const r3 = await call(env(kv3, { RESEND_API_KEY: undefined, EMAIL_FROM: undefined, TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' }), '/auth/start', { email: PAID });
  assert.equal(r3.status, 503); assert.match(r3.data.error, /聯絡站長/);
  assert.equal(net3.emails.length, 0);
  assert.equal(net3.telegram.length, 1); assert.doesNotMatch(net3.telegram[0], /\d{6}/); // 通知站長但不帶碼
});

test('Cloudflare Email Sending binding（EMAIL + MAIL_FROM）有綁就優先用', async () => {
  const kv = fakeKV(); const net = fakeNet(); const sent = [];
  const e = env(kv, { EMAIL: { async send(m) { sent.push(m); return { messageId: 'm1' }; } }, MAIL_FROM: '塔羅占卜 <tarot@example.com>' });
  await seedPaid(kv);
  assert.equal((await call(e, '/auth/start', { email: PAID })).status, 200);
  assert.equal(sent.length, 1); assert.equal(net.emails.length, 0);
  assert.equal(sent[0].to, PAID); assert.deepEqual(sent[0].from, { name: '塔羅占卜', email: 'tarot@example.com' });
  const code = /(\d{6})/.exec(sent[0].subject)[1];
  assert.equal((await call(e, '/auth/verify', { email: PAID, code })).status, 200);
  // binding 丟例外 → 失敗，不回 sent
  const e2 = env(fakeKV(), { EMAIL: { async send() { throw new Error('nope'); } }, MAIL_FROM: 'tarot@example.com' });
  await seedPaid(e2.TAROT_KV);
  assert.equal((await call(e2, '/auth/start', { email: PAID })).status, 503);
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

test('Gumroad 購後轉址：webhook 存的 sale_id 只能兌一次，同時兌兩次只發一個 token', async () => {
  const kv = fakeKV(); fakeNet(); const e = env(kv);
  // webhook 進來之前：對不上
  assert.deepEqual((await call(e, '/check', { email: PAID, sale_id: SALE })).data, { verified: false, needLogin: true });
  assert.equal(await webhook(e, { email: PAID, sale_id: SALE }), 200);
  assert.ok(kv.m.has(`email:${PAID}`));
  assert.deepEqual((await call(e, '/check', { email: PAID, sale_id: 'guess' })).data, { verified: false, needLogin: true });
  const rs = await Promise.all([call(e, '/check', { email: PAID, sale_id: SALE }), call(e, '/check', { email: PAID, sale_id: SALE })]);
  const toks = rs.filter(r => r.data.verified && r.data.token);
  assert.equal(toks.length, 1);
  assert.equal((await call(e, '/sync', { action: 'pull' }, toks[0].data.token)).status, 200);
  // 兌過的 sale_id 從網址歷史拿出來再打：沒用
  assert.deepEqual((await call(e, '/check', { email: PAID, sale_id: SALE })).data, { verified: false, needLogin: true });
  // Credit 儲值商品的 webhook 不會發兌換碼
  const e2 = env(fakeKV(), { CREDIT_PRODUCTS: 'crdt100:100' });
  assert.equal(await webhook(e2, { email: PAID, sale_id: 'sale_credit', permalink: 'crdt100' }), 200);
  assert.deepEqual((await call(e2, '/check', { email: PAID, sale_id: 'sale_credit' })).data, { verified: false, needLogin: true });
});

test('同一個 IP 一小時內狂打 /auth/start 會被擋；計數是原子的', async () => {
  const kv = fakeKV(); fakeNet(); const e = env(kv);
  const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => call(e, '/auth/start', { email: `u${i}@example.com` }, undefined, '1.2.3.4')));
  assert.equal(rs.filter(r => r.status === 200).length, 20);
  assert.equal(rs.filter(r => r.status === 429 && r.data.rateLimited).length, 5);
  assert.equal((await call(e, '/auth/start', { email: 'x@example.com' }, undefined, '5.6.7.8')).status, 200); // 別的 IP 不受影響
});

test('沒綁 AUTH_GATE 時登入端點回 503 說明，不會炸 500', async () => {
  const kv = fakeKV(); fakeNet(); const e = env(kv, { AUTH_GATE: undefined });
  await seedPaid(kv);
  const r = await call(e, '/auth/start', { email: PAID });
  assert.equal(r.status, 503); assert.equal(r.data.unconfigured, true);
  assert.equal((await call(e, '/auth/verify', { email: PAID, code: '123456' })).status, 503);
  assert.deepEqual((await call(e, '/check', { email: PAID, sale_id: SALE })).data, { verified: false, needLogin: true });
});

test('CORS 預檢放行 Authorization header', async () => {
  const res = await worker.fetch(new Request(W + '/sync', { method: 'OPTIONS', headers: { Origin: 'https://tarot.angiehu.com' } }), env(fakeKV()));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});
