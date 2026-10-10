import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from '../src/boards/build.mjs';
import { BOARD_SIZES } from '../src/config/weights.mjs';
import candidates from '../fixtures/candidates.json' with { type: 'json' };

const NOW = new Date('2026-10-10T00:00:00Z');

// 门槛挡下的四个候选：各自只违反一条门槛，便于定位回归。
const BLOCKED = ['bad/archived', 'bad/nolicense', 'bad/unverified', 'bad/stale'];

test('周榜遵守 15 条上限且按总分降序', () => {
  const b = buildBoard('weekly', candidates, NOW);
  assert.equal(b.length, 15);
  for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].score.total >= b[i].score.total);
});

test('门槛挡下的项目不出现在周榜与新手榜', () => {
  const ids = buildBoard('weekly', candidates, NOW).map((x) => x.repo.ownerRepo);
  for (const id of BLOCKED) assert.ok(!ids.includes(id), `${id} 不该出现在周榜`);
  const newbieIds = buildBoard('newbie', candidates, NOW).map((x) => x.repo.ownerRepo);
  for (const id of BLOCKED) assert.ok(!newbieIds.includes(id), `${id} 不该出现在新手榜`);
});

test('纯清单类不进新手榜但进经典榜', () => {
  const newbie = buildBoard('newbie', candidates, NOW).map((x) => x.repo.ownerRepo);
  const classic = buildBoard('classic', candidates, NOW).map((x) => x.repo.ownerRepo);
  assert.ok(!newbie.includes('awesome/list-only'));
  assert.ok(classic.includes('awesome/list-only'));
});

test('新手榜按新手友好分降序', () => {
  const b = buildBoard('newbie', candidates, NOW);
  for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].score.runnable >= b[i].score.runnable);
});

test('经典榜按收藏数降序且不受门槛限制', () => {
  const b = buildBoard('classic', candidates, NOW);
  for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].repo.stars >= b[i].repo.stars);
  assert.ok(b.length <= 30);
});

test('同分时按名称字典序稳定排序，且同一仓库进两个榜各自独立排名', () => {
  const w = buildBoard('weekly', candidates, NOW);
  const n = buildBoard('newbie', candidates, NOW);
  assert.ok(w.every((x) => Number.isInteger(x.rank) && x.rank >= 1));
  assert.ok(n.every((x) => Number.isInteger(x.rank) && x.rank >= 1));
  const both = w.map((x) => x.repo.ownerRepo).filter((id) => n.map((y) => y.repo.ownerRepo).includes(id));
  assert.ok(both.length >= 1);
});

// —— 以下为补充用例：三榜条数口径、同分顺序与候选形状 ——

test('三个榜单各自截断到 BOARD_SIZES 规定条数', () => {
  // 周榜与新手榜的合格候选足够填满，条数必须正好等于上限；
  // 经典榜只受上限约束（候选不够时允许不足 30 条）。
  assert.equal(buildBoard('weekly', candidates, NOW).length, BOARD_SIZES.weekly);
  assert.equal(buildBoard('newbie', candidates, NOW).length, BOARD_SIZES.newbie);
  assert.ok(buildBoard('classic', candidates, NOW).length <= BOARD_SIZES.classic);
  assert.equal(buildBoard('classic', candidates, NOW).length, candidates.length);
});

test('同分时按 ownerRepo 字典序升序，名次连续从 1 开始', () => {
  const b = buildBoard('weekly', candidates, NOW);
  const tied = b.filter((x) => x.repo.ownerRepo === 'alpha/tied-one' || x.repo.ownerRepo === 'beta/tied-two');
  assert.equal(tied.length, 2, '两个同分对照项目都应出现在周榜里');
  assert.equal(tied[0].score.total, tied[1].score.total, '两个对照项目的总分必须相同');
  assert.equal(tied[0].repo.ownerRepo, 'alpha/tied-one');
  assert.equal(tied[1].repo.ownerRepo, 'beta/tied-two');
  assert.deepEqual(b.map((x) => x.rank), b.map((_, i) => i + 1));
});

test('每条结果都是完整的 RankedItem，并带中文上榜理由', () => {
  const w = buildBoard('weekly', candidates, NOW);
  for (const x of w) {
    assert.deepEqual(
      Object.keys(x).sort(),
      ['chineseDoc', 'grade', 'rank', 'reasons', 'repo', 'runnability', 'score', 'velocity'],
    );
    assert.ok(Array.isArray(x.reasons));
    assert.ok(x.reasons.every((r) => typeof r === 'string' && r.length > 0));
  }
  const top = w[0];
  assert.equal(top.repo.ownerRepo, 'gamma/pdfsmith');
  assert.equal(top.chineseDoc, true);
  assert.equal(top.grade, 'green');
  assert.ok(top.reasons.length >= 1);
  // 新手榜前几名安装路径与中文分都是满分，同分时按 ownerRepo 字典序定先后。
  assert.equal(buildBoard('newbie', candidates, NOW)[0].repo.ownerRepo, 'epsilon/shrinkvid');
});
