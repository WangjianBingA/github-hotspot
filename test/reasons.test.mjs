import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReasons, formatVelocityText } from '../src/score/reasons.mjs';

test('实测不带"约"，估算必须带"约"与"估算"', () => {
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'measured' }), '本周新增收藏 1,234（实测）');
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'estimated' }), '本周新增收藏约 1,234（估算）');
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'reported' }), '本周新增收藏 1,234（GitHub 官方数据）');
});

test('理由里必须出现安装方式与中文信息', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7 } },
    repo: { pushedAt: new Date().toISOString() },
    velocity: { gained7d: 500, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.ok(rs.some(r => r.includes('Windows')));
  assert.ok(rs.some(r => r.includes('中文')));
});

test('理由中不得出现行话或字段名', () => {
  const rs = buildReasons({ score:{ parts:{ installPath:18, chinese:0 } },
    repo:{ pushedAt: new Date().toISOString() },
    velocity:{ gained7d:10, confidence:'measured' },
    runnability:{ kind:'releaseWindows', chineseDoc:false } });
  assert.ok(rs.every(r => !/\b(star|fork|issue)s?\b/i.test(r)));
  assert.ok(rs.every(r => !/[a-z]+_[a-z]+/.test(r)));
});

// —— 以下为补充用例：置信度分支、诚实度、顺序、上限与缺字段的健壮性 ——

test('没有增长数据就不写增长理由，也不猜置信度', () => {
  assert.equal(formatVelocityText(), '');
  assert.equal(formatVelocityText({}), '');
  assert.equal(formatVelocityText({ gained7d: 0, confidence: 'measured' }), '');
  assert.equal(formatVelocityText({ gained7d: -5, confidence: 'measured' }), '');
  assert.equal(formatVelocityText({ gained7d: 'abc', confidence: 'measured' }), '');
});

test('置信度缺失时不假装实测，只给不带括号的保守文案', () => {
  assert.equal(formatVelocityText({ gained7d: 1234 }), '本周新增收藏 1,234');
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: null }), '本周新增收藏 1,234');
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: '奇怪来源' }), '本周新增收藏 1,234');
});

test('增长理由排在最前，因为它是"为什么上榜"最想看的', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7 } },
    repo: { pushedAt: new Date().toISOString() },
    velocity: { gained7d: 1234, confidence: 'estimated' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.equal(rs[0], '本周新增收藏约 1,234（估算）');
});

test('每档安装方式都有一句给新手看的中文说法', () => {
  const kindText = (kind) => buildReasons({
    score: { parts: { installPath: 1 } },
    runnability: { kind }
  }).join(' | ');
  assert.match(kindText('releaseWindows'), /Windows/);
  assert.match(kindText('npmBinWin'), /命令/);
  assert.match(kindText('pypiCompatible'), /三步/);
  assert.match(kindText('npmNoBin'), /Node/);
  assert.match(kindText('buildFromSource'), /编译/);
  assert.match(kindText('dockerOnly'), /Docker/);
  assert.match(kindText('none'), /没有现成的安装方式/);
});

test('安装方式缺失但分数说有，就不说"没有现成的安装方式"', () => {
  const rs = buildReasons({ score: { parts: { installPath: 18, chinese: 0 } } });
  assert.ok(rs.every(r => !r.includes('没有现成的安装方式')));
  assert.equal(buildReasons({ score: { parts: { installPath: 0 } } }).join(' '), '暂时没有现成的安装方式，得自己动手');
});

test('中文理由可以由分数推出，不必重复传 chineseDoc', () => {
  const rs = buildReasons({ score: { parts: { installPath: 18, chinese: 7 } } });
  assert.ok(rs.some(r => r.includes('中文')));
});

test('已停止维护的项目只说"作者已停止维护"，不说更新与管事', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 6, issueClosure: 8, license: 3 } },
    repo: { pushedAt: new Date().toISOString(), archived: true },
    velocity: { gained7d: 500, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.ok(rs.includes('作者已停止维护'));
  assert.ok(rs.every(r => !r.includes('仍在更新')));
  assert.ok(rs.every(r => !r.includes('管事')));
});

test('近期有提交、作者管事、许可证齐全各自成为口碑理由', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 6, issueClosure: 8, license: 3 } }
  });
  assert.ok(rs.some(r => r.includes('仍在更新')));
  assert.ok(rs.some(r => r.includes('管事')));
  assert.ok(rs.some(r => r.includes('许可证')));
  assert.ok(rs.length <= 5);
});

test('口碑分不足满分时不下"作者管事""许可证齐全"的结论', () => {
  const rs = buildReasons({ score: { parts: { installPath: 18, chinese: 0, issueClosure: 2, license: 0 } } });
  assert.ok(rs.every(r => !r.includes('管事')));
  assert.ok(rs.every(r => !r.includes('许可证')));
});

test('缺字段、空对象、null 都不抛错，且理由条数与内容都干净', () => {
  for (const input of [undefined, null, {}, { score: {} }, { score: null, repo: null, velocity: null, runnability: null }]) {
    const rs = buildReasons(input);
    assert.ok(Array.isArray(rs), '永远返回数组');
    assert.ok(rs.length >= 1 && rs.length <= 5, `条数在 1-5 之间，实际 ${rs.length}`);
    assert.ok(rs.every(r => typeof r === 'string' && r.trim() !== ''), '没有空字符串');
    assert.ok(rs.every(r => !/\b(star|fork|issue)s?\b/i.test(r)), '没有行话');
    assert.ok(rs.every(r => !/[a-z]+_[a-z]+/.test(r)), '没有字段名');
  }
});

test('理由最多 5 条，宁缺毋滥', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 6, issueClosure: 8, license: 3 } },
    repo: { pushedAt: new Date().toISOString() },
    velocity: { gained7d: 9999, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.ok(rs.length >= 3, '信息充足时至少 3 条');
  assert.ok(rs.length <= 5, '不超过 5 条');
  assert.equal(new Set(rs).size, rs.length, '不重复');
});
