// 產好友碼（Angie 送朋友免費體驗）：印出碼，KV 只存碼的雜湊（碼本身不進 repo、不進 KV）。
// 用法：node scripts/friend-codes.mjs [幾個=10] [每個幾次=10] [幾天內要兌換=90]
// 會用 wrangler 寫進正式 KV（TAROT_KV），要先 wrangler login。
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [count = 10, credits = 10, days = 90] = process.argv.slice(2).map(Number);
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 沒有 0/O、1/I，念給別人聽不會搞混
const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => ALPHA[b % ALPHA.length]).join('');
const hash = async (c) => {
  const norm = c.toUpperCase().replace(/[^A-Z0-9]/g, ''); // 跟 worker.js normFriendCode 一樣
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`fcode:${norm}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

const exp = Date.now() + days * 86400000;
const codes = Array.from({ length: count }, () => `FRIEND-${rand(4)}-${rand(4)}`);
const items = await Promise.all(codes.map(async (c) => ({
  key: `fcode:${await hash(c)}`,
  value: JSON.stringify({ credits, exp, made: new Date().toISOString() }),
  expiration_ttl: days * 86400 + 7 * 86400, // 過期後再留一週，兌換時才講得出「過期了」而不是「碼不對」
})));
const dir = mkdtempSync(join(tmpdir(), 'fcodes-'));
const file = join(dir, 'bulk.json');
writeFileSync(file, JSON.stringify(items));
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'TAROT_KV', '--remote', '--config', join(root, 'wrangler.toml')], { stdio: 'inherit', cwd: root });
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${count} 個好友碼（每個 ${credits} 次，${new Date(exp).toLocaleDateString('zh-TW')} 前要兌換）：`);
for (const c of codes) console.log(`${c}  https://tarot.angiehu.com/?friend=${c}`);
