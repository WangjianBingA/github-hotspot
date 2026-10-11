import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHot } from '../src/score/score.mjs';
import { WEIGHTS, HOT_REFERENCE_STARS_PER_WEEK } from '../src/config/weights.mjs';

test('新增收藏为 0 时得 0 分，不得为 NaN', () => {
  assert.equal(scoreHot({ starsGained7d: 0 }), 0);
});

test('达到参考值时拿满分', () => {
  assert.equal(scoreHot({ starsGained7d: HOT_REFERENCE_STARS_PER_WEEK }), WEIGHTS.hot);
});

test('55 万星级项目的巨量新增也封顶在满分，不溢出', () => {
  const s = scoreHot({ starsGained7d: 200000 });
  assert.equal(s, WEIGHTS.hot);
  assert.ok(Number.isFinite(s));
});

test('小项目不因数值小而得负分或 NaN', () => {
  assert.ok(scoreHot({ starsGained7d: 1 }) > 0);
});

test('缺失或非法输入按 0 处理而不是抛错', () => {
  assert.equal(scoreHot({ starsGained7d: undefined }), 0);
  assert.equal(scoreHot({ starsGained7d: -5 }), 0);
  assert.equal(scoreHot({ starsGained7d: NaN }), 0);
});
