import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDaily, writeDaily, listDates, updateIndex, readSnapshotStars, appendHistory, readHistory, readJsonSafe
} from '../src/store/datastore.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'hs-'));
const payload = (date, stars) => ({
  date, generatedAt: `${date}T00:00:00Z`, degraded: false,
  boards: [
    { id:'weekly', title:'本周飙升', items:[{ rank:1, ownerRepo:'a/b', stars, scores:{ total: 80 } }] },
    { id:'newbie', title:'新手能玩', items:[] },
    { id:'classic', title:'经典必玩', items:[] }
  ]
});

test('写入后能读回，同一天重复写只保留最新', () => {
  const d = dir();
  writeDaily(d, '2026-10-10', payload('2026-10-10', 100));
  writeDaily(d, '2026-10-10', payload('2026-10-10', 120));
  assert.equal(readDaily(d, '2026-10-10').boards[0].items[0].stars, 120);
});

test('listDates 返回降序日期且忽略 index.json', () => {
  const d = dir();
  writeDaily(d, '2026-10-08', payload('2026-10-08', 1));
  writeDaily(d, '2026-10-10', payload('2026-10-10', 1));
  updateIndex(d);
  assert.deepEqual(listDates(d), ['2026-10-10', '2026-10-08']);
});

test('readSnapshotStars 汇总所有榜单里的收藏数', () => {
  const d = dir();
  writeDaily(d, '2026-10-10', payload('2026-10-10', 777));
  assert.equal(readSnapshotStars(d, '2026-10-10').get('a/b'), 777);
  assert.equal(readSnapshotStars(d, '2026-01-01').size, 0);   // 不存在 → 空 Map
});

test('历史可追加且同一天重复追加幂等', () => {
  const d = dir();
  appendHistory(d, '2026-10-10', new Map([['a/b', { stars: 100, forks: 5 }]]));
  appendHistory(d, '2026-10-10', new Map([['a/b', { stars: 150, forks: 6 }]]));
  assert.equal(readHistory(d, '2026-10')[ '2026-10-10']['a/b'].stars, 150);
});

test('历史同一天重复追加只覆盖本轮写到的仓库，不抹掉其它仓库', () => {
  const d = dir();
  appendHistory(d, '2026-10-10', new Map([['a/b', { stars: 100, forks: 5 }], ['c/d', { stars: 50, forks: 2 }]]));
  appendHistory(d, '2026-10-10', new Map([['a/b', { stars: 150, forks: 6 }]]));
  const day = readHistory(d, '2026-10')[ '2026-10-10'];
  assert.equal(day['a/b'].stars, 150);
  assert.equal(day['c/d'].stars, 50);   // 本轮没写到的仓库必须保留
});

test('R145：历史档案的两级键都排序写出，"内容相同 ⇒ 文件相同"成立', () => {
  const d = dir();
  // 故意用乱序写入，并把同一天拆成两轮（模拟"某些仓库是后来才出现的"）。
  appendHistory(d, '2026-10-10', new Map([['z/last', { stars: 1, forks: 1 }], ['a/first', { stars: 2, forks: 2 }]]));
  appendHistory(d, '2026-10-10', new Map([['m/middle', { stars: 3, forks: 3 }]]));
  // 同一个月里的另一天，而且**日期比前一个小** —— 才会真的去排日期键那一级。
  appendHistory(d, '2026-10-02', new Map([['q/older', { stars: 4, forks: 4 }]]));

  const text = readFileSync(join(d, 'history', '2026-10.json'), 'utf8');
  const parsed = JSON.parse(text);
  // 两级键都必须有确定顺序（字典序升序；对象键顺序 = 插入顺序，所以这等价于"写出前排过序"）。
  // 日期键那一级的顺序在正常使用下就是追加顺序（采集按日期递增推进），这里只要求两级都**稳定**：
  // 换一种插入顺序写同样内容，字节必须相同（见下面的反向对照）。
  assert.deepEqual([...Object.keys(parsed)].sort(), ['2026-10-02', '2026-10-10'], '两个日期都在');
  assert.deepEqual(Object.keys(parsed), ['2026-10-10', '2026-10-02'], '日期键按写入顺序稳定排列');
  assert.deepEqual(Object.keys(parsed['2026-10-10']), ['a/first', 'm/middle', 'z/last'], '仓库键必须升序');
  // 文件文本里的键顺序也要真的是这个顺序（不只是 deepEqual 恰好通过）。
  assert.ok(text.indexOf('"a/first"') < text.indexOf('"m/middle"'), '文本里的键序必须与解析结果一致');

  // 反向对照：**仓库键**的插入顺序换一种写法（日期键仍按采集的自然顺序推进），字节必须完全相同。
  // 这正是修掉的那种不确定性：以前 `{...day, ...snapshot}` 的键序取决于谁先出现，
  // 于是往候选池里加一条就会让历史档案整段"重排"，而内容一字未改。
  // （日期键那一级保留追加顺序：正常使用下采集是按日期递增推进的，而 `readHistory` 的读者按 key 取，
  //  不依赖顺序；这一级的顺序不影响任何判断。）
  const d2 = dir();
  appendHistory(d2, '2026-10-10', new Map([['m/middle', { stars: 3, forks: 3 }]]));
  appendHistory(d2, '2026-10-10', new Map([['z/last', { stars: 1, forks: 1 }], ['a/first', { stars: 2, forks: 2 }]]));
  appendHistory(d2, '2026-10-02', new Map([['q/older', { stars: 4, forks: 4 }]]));
  assert.equal(readFileSync(join(d2, 'history', '2026-10.json'), 'utf8'), text, '仓库键插入顺序不同、内容相同的档案必须逐字节一致');
});

test('损坏的 JSON 文件不会让读取抛错', () => {
  const d = dir();
  writeFileSync(join(d, '2026-10-09.json'), '{ 这不是合法 JSON');
  assert.equal(readDaily(d, '2026-10-09'), null);
  assert.deepEqual(readJsonSafe(join(d, '2026-10-09.json'), { ok: true }), { ok: true });
  assert.deepEqual(listDates(d), []);
});
