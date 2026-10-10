import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReasons, formatVelocityText } from '../src/score/reasons.mjs';
// R50：要用真实的评分函数验证"分数不能说成事实"，而不是自己手写 parts。
import { scoreReputation } from '../src/score/score.mjs';
import { DETAIL_WEIGHTS } from '../src/config/weights.mjs';

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

test('"查过了确实没有"与"没人告诉我们有没有"不能混为一谈', () => {
  // ① kind 明确是 none：查过了，确实没有安装方式——这句否定句有证据，可以说。
  const told = buildReasons({ score: { parts: { installPath: 0 } }, runnability: { kind: 'none' } });
  assert.ok(told.some(r => r.includes('没有现成的安装方式')), 'none 要给出确定的否定句');

  // ② kind 缺失：没人告诉我们，score.mjs 同样记 0 分，但 0 分 ≠ 确定没有，所以一句都不说。
  const unknown = buildReasons({ score: { parts: { installPath: 0 } } });
  assert.ok(unknown.every(r => !r.includes('安装')), `不知道就不猜，实际输出：${JSON.stringify(unknown)}`);

  // ③ kind 是没见过的值：同上，不猜。
  const strange = buildReasons({ score: { parts: { installPath: 0 } }, runnability: { kind: '奇怪的kind' } });
  assert.ok(strange.every(r => !r.includes('安装')), `未知 kind 也不猜，实际输出：${JSON.stringify(strange)}`);

  // ④ kind 未知但分数说 18 分：知道有路可走，只是不知道是哪一种——给泛化句，不说"没有"。
  const scored = buildReasons({ score: { parts: { installPath: 18 } } });
  assert.ok(scored.some(r => r.includes('有现成的安装方式')));
  assert.ok(scored.every(r => !r.includes('没有现成的安装方式')));
});

test('中文理由可以由分数推出，不必重复传 chineseDoc', () => {
  const rs = buildReasons({ score: { parts: { installPath: 18, chinese: 7 } } });
  assert.ok(rs.some(r => r.includes('中文')));
});

test('已停止维护的项目给停机结论，许可证这条依然为真、照旧输出', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 8, release90d: 6, license: 4 } },
    repo: { pushedAt: new Date().toISOString(), archived: true },
    velocity: { gained7d: 500, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.ok(rs.includes('作者已停止维护'));
  // 归档只说明"不再更新"，不代表"没有许可证"——这句仍然为真，必须照旧输出。
  assert.ok(rs.includes('有明确的开源许可证，能放心用'));
  assert.ok(rs.every(r => !r.includes('仍在更新')));
  assert.ok(rs.every(r => !r.includes('新版本')));
});

test('近期有提交、近 90 天发过新版本、许可证齐全各自成为口碑理由', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 8, release90d: 6, license: 4 } },
    // R50：这一句读的是事实（repo.hasRelease90d），不是分数——所以要给出这个事实。
    repo: { pushedAt: new Date().toISOString(), hasRelease90d: true }
  });
  assert.ok(rs.some(r => r.includes('仍在更新')));
  assert.ok(rs.some(r => r.includes('新版本')));
  assert.ok(rs.some(r => r.includes('许可证')));
  assert.ok(rs.length <= 5);
});

// R50：这句话断言的是"确认在 90 天内发过版"，所以只能由**事实**触发，不能由分数触发。
// R40 让"未知"拿到中性半分 3 分，若门槛继续读分数（parts.release90d > 0），
// 我们就会在并不知道的情况下对用户说"作者最近还发过新版本"——把"没问到"说成"确认如此"。
// 与之配套：门槛不依赖 DETAIL_WEIGHTS.release90d 的数值，日后调分不会静默改变文案行为。
test('只有"确认近期发过版"才说"作者最近还发过新版本"，未知与确认没有都不说（R50）', () => {
  // 三条输入只差 hasRelease90d（三态：true / false / null），其余字段完全相同。
  const make = (hasRelease90d) => ({
    score: { parts: { installPath: 18, chinese: 0, release90d: 6, license: 0 } },
    repo: { pushedAt: '2026-09-01T00:00:00Z', hasRelease90d }
  });

  const confirmed = buildReasons(make(true), new Date('2026-10-10T00:00:00Z'));
  assert.ok(confirmed.some(r => r.includes('新版本')), `确认发过版要出这句话，实际：${JSON.stringify(confirmed)}`);

  for (const value of [false, null, undefined]) {
    const rs = buildReasons(make(value), new Date('2026-10-10T00:00:00Z'));
    assert.ok(rs.every(r => !r.includes('新版本')),
      `hasRelease90d=${String(value)} 时不得下"发过新版本"的结论，实际：${JSON.stringify(rs)}`);
  }

  // 分数在三种输入下一模一样（都是满分 6），全靠事实区分——这正是本用例的意义。
  for (const value of [true, false, null]) {
    assert.equal(make(value).score.parts.release90d, 6);
  }
});

test('未知的发版事实（null，中性半分 3）绝不能被读成"发过新版本"（R40 + R50）', () => {
  // 用真实的 scoreReputation 产出分数，而不是手写 parts：这是端到端钉住两层口径一致。
  const repo = { stars: 1000, forks: 150, pushedAt: '2026-09-01T00:00:00Z', license: 'MIT', hasRelease90d: null };
  const score = scoreReputation(repo, { growing: true }, new Date('2026-10-10T00:00:00Z'));
  assert.equal(score.parts.release90d, DETAIL_WEIGHTS.release90d / 2);   // 3 分，> 0
  const rs = buildReasons({ score, repo }, new Date('2026-10-10T00:00:00Z'));
  assert.ok(rs.every(r => !r.includes('新版本')), `3 分是"没问到"，不能出这句，实际：${JSON.stringify(rs)}`);
});

test('没有发版、没有许可证就不下"发过新版本""许可证齐全"的结论', () => {
  const rs = buildReasons({ score: { parts: { installPath: 18, chinese: 0, release90d: 0, license: 0 } } });
  assert.ok(rs.every(r => !r.includes('新版本')));
  assert.ok(rs.every(r => !r.includes('许可证')));
});

test('缺字段、空对象、null 都不抛错，且理由条数与内容都干净', () => {
  for (const input of [undefined, null, {}, { score: {} }, { score: null, repo: null, velocity: null, runnability: null }]) {
    const rs = buildReasons(input);
    assert.ok(Array.isArray(rs), '永远返回数组');
    assert.ok(rs.length <= 5, `条数不超过 5，实际 ${rs.length}`);
    assert.deepEqual(rs, [], `完全没有证据时不产出任何断言，实际输出：${JSON.stringify(rs)}`);
    assert.ok(rs.every(r => typeof r === 'string' && r.trim() !== ''), '没有空字符串');
    assert.ok(rs.every(r => !/\b(star|fork|issue)s?\b/i.test(r)), '没有行话');
    assert.ok(rs.every(r => !/[a-z]+_[a-z]+/.test(r)), '没有字段名');
  }
});

test('宁缺毋滥：没有证据就返回空数组，不为凑数编理由', () => {
  assert.deepEqual(buildReasons(), []);
  assert.deepEqual(buildReasons({ velocity: { gained7d: 0, confidence: 'measured' } }), []);
  // 有零散证据时，只写有证据的那几条。
  assert.deepEqual(
    buildReasons({ score: { parts: { license: 4 } } }),
    ['有明确的开源许可证，能放心用'],
  );
});

test('理由最多 5 条，宁缺毋滥', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 8, release90d: 6, license: 4 } },
    repo: { pushedAt: new Date().toISOString() },
    velocity: { gained7d: 9999, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.ok(rs.length >= 3, '信息充足时至少 3 条');
  assert.ok(rs.length <= 5, '不超过 5 条');
  assert.equal(new Set(rs).size, rs.length, '不重复');
});
