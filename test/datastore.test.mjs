import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

test('损坏的 JSON 文件不会让读取抛错', () => {
  const d = dir();
  writeFileSync(join(d, '2026-10-09.json'), '{ 这不是合法 JSON');
  assert.equal(readDaily(d, '2026-10-09'), null);
  assert.deepEqual(readJsonSafe(join(d, '2026-10-09.json'), { ok: true }), { ok: true });
  assert.deepEqual(listDates(d), []);
});
