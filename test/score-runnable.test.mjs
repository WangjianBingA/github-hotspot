import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRunnable, calculateGrade } from '../src/score/score.mjs';

// R153：判据字段是 `hasChinese`（历史名 `chineseDoc` 已删除）。
// 这个文件顺便把"删干净了"这件事钉住：给 `chineseDoc` 不再有任何效果。
test('Windows 安装包得 18 分，加中文说明共 25', () => {
  const r = scoreRunnable({ kind:'releaseWindows', hasChinese:true });
  assert.equal(r.parts.installPath, 18);
  assert.equal(r.total, 25);
});

test('没有中文说明时不给中文分', () => {
  assert.equal(scoreRunnable({ kind:'releaseWindows', hasChinese:false }).parts.chinese, 0);
  assert.equal(scoreRunnable({ kind:'releaseWindows' }).parts.chinese, 0);
});

test('R153：已经删掉的历史名 chineseDoc 不再影响任何一分', () => {
  // 这正是删除它的理由：两个名字指同一件事、却由评分与文案各读一个。
  // 现在给 chineseDoc 什么都不发生（否则手写数据又能造出"评分说有中文、徽章说没有"的条目）。
  assert.equal(scoreRunnable({ kind:'releaseWindows', chineseDoc:true }).parts.chinese, 0);
  assert.equal(scoreRunnable({ kind:'releaseWindows', chineseDoc:true }).total, 18);
});

test('中文说明那一项满给 7 分（不按比例）', () => {
  assert.equal(scoreRunnable({ kind:'pypiCompatible', hasChinese:true }).parts.chinese, 7);
});

test('未知 kind 得 0 分而不是 NaN', () => {
  assert.equal(scoreRunnable({ kind:'奇怪的kind', hasChinese:false }).parts.installPath, 0);
});

// 补充用例：未知 kind 连总分也不能是 NaN。
test('未知 kind 的总分为 0，原型链上的同名键也不算分', () => {
  assert.equal(scoreRunnable({ kind:'奇怪的kind', hasChinese:false }).total, 0);
  assert.equal(scoreRunnable({ kind:'toString', hasChinese:false }).total, 0);
});

test('难度分级：18/16 绿，14/8 黄，6/4/0 红', () => {
  assert.equal(calculateGrade(18), 'green');
  assert.equal(calculateGrade(16), 'green');
  assert.equal(calculateGrade(14), 'yellow');
  assert.equal(calculateGrade(8),  'yellow');
  assert.equal(calculateGrade(6),  'red');
  assert.equal(calculateGrade(0),  'red');
});
