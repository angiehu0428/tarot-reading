// 專案合併（mergeProjects）回歸案例：從 app.js 把函式抽出來跑，不載入整個前端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const endSan = src.indexOf('\n', src.indexOf('function sanitizeRecs('));
const body = src.slice(src.indexOf('function sanitizeRec('), endSan) + '\n' + cut('function projRemoved(', 'async function syncPull');
const { mergeProjects, recContentKey } = new Function(body + '; return { mergeProjects, recContentKey };')();

const rec = (id, interp = '', chat = []) => ({ id, q: 'q', cards: [{ cid: 0, rev: false }], pos: [], interp, chat });
const proj = (id, readings, name = 'P') => ({ id, name, desc: '', color: '#fff', createdAt: 'x', readings });

test('兩台各自把不同占卜加入同一專案 → 聯集、照 id 排序', () => {
  const out = mergeProjects([proj(1, [rec(20, 'b')])], [proj(1, [rec(10, 'a')])]);
  assert.deepEqual(out[0].readings.map(r => r.id), [10, 20]);
});

test('同一筆：雲端是空解讀、本機有解讀 → 留本機', () => {
  const out = mergeProjects([proj(1, [rec(10, '完整解讀')])], [proj(1, [rec(10, '')])]);
  assert.equal(out[0].readings[0].interp, '完整解讀');
});

test('同一筆：本機是空解讀、雲端有解讀 → 留雲端，不被舊的蓋掉', () => {
  const out = mergeProjects([proj(1, [rec(10, '')])], [proj(1, [rec(10, '完整解讀')])]);
  assert.equal(out[0].readings[0].interp, '完整解讀');
  assert.equal(out[0].readings.length, 1);
});

test('同一筆：追問比較多的那邊留下', () => {
  const more = [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }];
  const out = mergeProjects([proj(1, [rec(10, 'x')])], [proj(1, [rec(10, 'x', more)])]);
  assert.equal(out[0].readings[0].chat.length, 2);
});

test('一樣完整 → 留本機；專案名稱以本機為準', () => {
  const out = mergeProjects([proj(1, [rec(10, '本機版')], '新名字')], [proj(1, [rec(10, '雲端版')], '舊名字')]);
  assert.equal(out[0].readings[0].interp, '本機版');
  assert.equal(out[0].name, '新名字');
});

// 有更新時間（upd）的記錄：留比較新的，不看誰比較長
const recU = (id, upd, interp, chat = []) => ({ ...rec(id, interp, chat), upd });
const chat2 = [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }];

test('重新解析後（新解讀、追問清空）不會被另一台追問比較多的舊副本蓋回去', () => {
  const fresh = recU(10, 2000, '重新解析的新解讀');
  const stale = recU(10, 1000, '舊解讀比較長比較長比較長', chat2);
  assert.equal(mergeProjects([proj(1, [fresh])], [proj(1, [stale])])[0].readings[0].interp, '重新解析的新解讀');
  assert.equal(mergeProjects([proj(1, [stale])], [proj(1, [fresh])])[0].readings[0].interp, '重新解析的新解讀');
});

test('重送成功的回答比較短，也不會被舊的失敗問答蓋回去', () => {
  const ok = recU(10, 3000, 'x', [{ role: 'user', text: 'q' }, { role: 'model', text: '好' }]);
  const failed = recU(10, 1000, 'x', [{ role: 'user', text: 'q' }, { role: 'model', text: '連線失敗，請再試一次，這段很長很長' }, { role: 'user', text: 'q' }]);
  const out = mergeProjects([proj(1, [failed])], [proj(1, [ok])]);
  assert.equal(out[0].readings[0].chat[1].text, '好');
});

test('一邊是舊資料（沒有 upd）、一邊有 upd → 留有 upd 的', () => {
  const out = mergeProjects([proj(1, [rec(10, '舊資料很長很長很長', chat2)])], [proj(1, [recU(10, 500, '新版存的')])]);
  assert.equal(out[0].readings[0].interp, '新版存的');
});

test('內容指紋：沒改內容就一樣（不會只因為再存一次就算更新），改了解讀或追問就不同', () => {
  const a = recU(10, 1000, '解讀', chat2);
  assert.equal(recContentKey(a), recContentKey({ ...a, upd: 9999, date: '別的日期' }));
  assert.notEqual(recContentKey(a), recContentKey({ ...a, interp: '重新解析' }));
  assert.notEqual(recContentKey(a), recContentKey({ ...a, chat: [] }));
});

test('舊副本沒改內容再存一次（upd 不變）→ 不會蓋掉另一台重新解析的新版', () => {
  const stale = recU(10, 1000, '舊解讀', chat2);       // B 裝置：只是再按一次儲存，upd 沿用 1000
  const fresh = recU(10, 2000, '重新解析的新解讀');   // A 裝置：重新解析
  assert.equal(mergeProjects([proj(1, [stale])], [proj(1, [fresh])])[0].readings[0].interp, '重新解析的新解讀');
});

// 加入／移出紀錄（mv）
const projMv = (id, readings, mv) => ({ ...proj(id, readings), mv });

test('本機移出、雲端還留著舊副本 → 合併後不會被補回來', () => {
  const out = mergeProjects([projMv(1, [], { 10: { t: 2000, in: 0 } })], [proj(1, [rec(10, 'a'), rec(11, 'b')])]);
  assert.deepEqual(out[0].readings.map(r => r.id), [11]);
  assert.equal(out[0].mv[10].in, 0);
});

test('雲端說移出、本機還沒更新 → 合併後也移出', () => {
  const out = mergeProjects([proj(1, [rec(10, 'a')])], [projMv(1, [], { 10: { t: 2000, in: 0 } })]);
  assert.equal(out[0].readings.length, 0);
});

test('移出後又加回來（比較新的動作是加入）→ 留在專案裡，兩個方向都一樣', () => {
  const readd = projMv(1, [rec(10, 'a')], { 10: { t: 3000, in: 1 } });
  const removed = projMv(1, [], { 10: { t: 2000, in: 0 } });
  assert.equal(mergeProjects([readd], [removed])[0].readings.length, 1);
  assert.equal(mergeProjects([removed], [readd])[0].readings.length, 1);
});

test('加入後又移出（比較新的動作是移出）→ 不在專案裡', () => {
  const added = projMv(1, [rec(10, 'a')], { 10: { t: 1000, in: 1 } });
  const removed = projMv(1, [], { 10: { t: 2000, in: 0 } });
  assert.equal(mergeProjects([added], [removed])[0].readings.length, 0);
  assert.equal(mergeProjects([removed], [added])[0].readings.length, 0);
});

test('沒有 mv 的舊專案照舊聯集，也不會長出空的 mv', () => {
  const out = mergeProjects([proj(1, [rec(10, 'a')])], [proj(1, [rec(11, 'b')])]);
  assert.equal(out[0].readings.length, 2);
  assert.equal('mv' in out[0], false);
});
