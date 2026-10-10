import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRunnable, calculateGrade } from '../src/score/score.mjs';

test('Windows 安装包得 18 分，加中文文档共 25', () => {
  const r = scoreRunnable({ kind:'releaseWindows', chineseDoc:true });
  assert.equal(r.parts.installPath, 18);
  assert.equal(r.total, 25);
});

test('无中文文档时不给中文分', () => {
  assert.equal(scoreRunnable({ kind:'releaseWindows', chineseDoc:false }).parts.chinese, 0);
});

test('中文分封顶 7 分', () => {
  assert.equal(scoreRunnable({ kind:'pypiCompatible', chineseDoc:true }).parts.chinese, 7);
});

test('未知 kind 得 0 分而不是 NaN', () => {
  assert.equal(scoreRunnable({ kind:'奇怪的kind', chineseDoc:false }).parts.installPath, 0);
});

// 补充用例：未知 kind 连总分也不能是 NaN。
test('未知 kind 的总分为 0，原型链上的同名键也不算分', () => {
  assert.equal(scoreRunnable({ kind:'奇怪的kind', chineseDoc:false }).total, 0);
  assert.equal(scoreRunnable({ kind:'toString', chineseDoc:false }).total, 0);
});

test('难度分级：18/16 绿，14/8 黄，6/4/0 红', () => {
  assert.equal(calculateGrade(18), 'green');
  assert.equal(calculateGrade(16), 'green');
  assert.equal(calculateGrade(14), 'yellow');
  assert.equal(calculateGrade(8),  'yellow');
  assert.equal(calculateGrade(6),  'red');
  assert.equal(calculateGrade(0),  'red');
});
