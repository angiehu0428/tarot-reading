// 專案合併（mergeProjects）回歸案例：從 app.js 把函式抽出來跑，不載入整個前端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const endSan = src.indexOf('\n', src.indexOf('function sanitizeRecs('));
const body = src.slice(src.indexOf('function sanitizeRec('), endSan) + '\n' + cut('function recRicher(', 'async function syncPull');
const { mergeProjects, projReadingCount } = new Function(body + '; return { mergeProjects, projReadingCount };')();

const rec = (id, interp = '', chat = []) => ({ id, q: 'q', cards: [{ cid: 0, rev: false }], pos: [], interp, chat });
const proj = (id, readings, name = 'P') => ({ id, name, desc: '', color: '#fff', createdAt: 'x', readings });

test('兩台各自把不同占卜加入同一專案 → 聯集、照 id 排序', () => {
  const out = mergeProjects([proj(1, [rec(20, 'b')])], [proj(1, [rec(10, 'a')])]);
  assert.deepEqual(out[0].readings.map(r => r.id), [10, 20]);
  assert.equal(projReadingCount(out), 2);
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
