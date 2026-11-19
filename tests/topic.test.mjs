// 主題判斷（detectTopic）回歸案例：從 app.js 把函式抽出來跑，不載入整個前端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('function detectTopic'), src.indexOf('function topicLabel'));
const detectTopic = new Function(body + '; return detectTopic;')();

const cases = [
  ['他會回到公司嗎 接下來半年他跟公司狀況如何', 'career'],
  ['我該離職嗎', 'career'],
  ['他在公司的發展', 'career'],
  ['公司同事喜歡我嗎', 'love'],
  ['公司主管喜歡我嗎', 'love'],
  ['他喜歡喜歡我的同事嗎', 'love'],
  ['我跟他的感情，他在公司很忙', 'love'],
  ['他喜歡我嗎', 'love'],
  ['她最近好嗎', 'love'],
  ['他考試會過嗎', 'study'],
  ['今天運勢', 'general'],
  ['Will he return to the company as CEO?', 'career'],
  ['Is he happy at work?', 'career'],
  ['How is my work going', 'career'],
  ['Will my relationship work?', 'love'],
  ['Will my relationship work in the future?', 'love'],
  ['Will our relationship work!', 'love'],
  ['Will things work out with him?', 'love'],
  ['Will my team win?', 'general'],
];
for (const [q, want] of cases) test(`${q} → ${want}`, () => assert.equal(detectTopic(q), want));
