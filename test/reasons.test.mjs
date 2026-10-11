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
    runnability: { kind: 'releaseWindows', hasChinese: true }
  });
  assert.ok(rs.some(r => r.includes('Windows')));
  assert.ok(rs.some(r => r.includes('中文')));
});

test('理由中不得出现行话或字段名', () => {
  const rs = buildReasons({ score:{ parts:{ installPath:18, chinese:0 } },
    repo:{ pushedAt: new Date().toISOString() },
    velocity:{ gained7d:10, confidence:'measured' },
    runnability:{ kind:'releaseWindows', hasChinese:false } });
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
    runnability: { kind: 'releaseWindows', hasChinese: true }
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
  assert.match(kindText('none'), /我们没有找到/);
});

test('认识的 kind 与"没人告诉我们有没有"不能混为一谈（R73 后 none 也不断言项目事实）', () => {
  // ① kind 明确是 none：这一档有话说，但说的是**我们的查找动作**——classifyRunnability 走到 none
  //    的常见原因恰恰是证据缺失（没查到包 / 包无法确认属于该项目 / 命令行工具不支持 Windows），
  //    所以它绝不能断言"这个项目没有现成的安装方式"（R70/R73 同一口径）。
  const told = buildReasons({ score: { parts: { installPath: 0 } }, runnability: { kind: 'none' } });
  assert.ok(told.some(r => r.includes('我们没有找到')), 'none 要说清我们查过了');
  assert.ok(told.every(r => !r.includes('没有现成的安装方式')), 'R73：不得替项目下否定结论');

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

// R73：旧文案 '暂时没有现成的安装方式，得自己动手' 断言的是**项目的事实**，而 none 档恰恰是
// 我们不知道的那种状态（证据缺失）。本项目已修正八次同类缺陷，因此：
//   · 主语必须是我们的查找动作（与 runnability.mjs 的「我们没有找到可以放心推荐给你的安装方式」同一口径）；
//   · 不出现"没有现成的安装方式"这个被推翻的说法；
//   · 不给一条关于用户机器的断言，只给一条能走的下一步（去项目主页看它自己怎么写的）。
test('R73：none 档只说"我们没有找到"，不再断言"没有现成的安装方式"', () => {
  const rs = buildReasons({ score: { parts: { installPath: 0 } }, runnability: { kind: 'none' } });
  const text = rs.join(' | ');
  assert.ok(text.includes('安装'), `none 档仍要给出这一条，实际：${JSON.stringify(rs)}`);
  assert.ok(!text.includes('没有现成的安装方式'), `不得再替项目下否定结论，实际：${JSON.stringify(rs)}`);
  assert.ok(text.includes('我们没有找到'), `主语必须是我们的查找动作，实际：${JSON.stringify(rs)}`);
  assert.ok(text.includes('项目主页'), `要给一条可走的下一步，实际：${JSON.stringify(rs)}`);
  // 这句话里不得出现任何自称"这个项目没有…"的断言式说法。
  assert.ok(!text.includes('这个项目'), `不得断言项目事实，实际：${JSON.stringify(rs)}`);
  assert.ok(rs.length === 1, `这一档只产出安装方式一条，实际：${JSON.stringify(rs)}`);
});

test('R143：中文那一条读事实（hasChinese），不读分数', () => {
  // ① 有中文 → 出这句。
  const yes = buildReasons({ score: { parts: { installPath: 18, chinese: 7 } }, runnability: { kind: 'releaseWindows', hasChinese: true } });
  assert.ok(yes.some((r) => r.includes('有中文说明')), JSON.stringify(yes));
  // ② 分数里有 7 分但事实是"没有中文"（只有日文文档）→ **绝不说有中文**，改成如实说非中文。
  const ja = buildReasons({
    score: { parts: { installPath: 18, chinese: 7 } },
    runnability: { kind: 'releaseWindows', hasChinese: false, localizedFiles: ['README.ja.md'] },
  });
  assert.ok(!ja.some((r) => r.includes('有中文说明')), `不许把日文文档说成中文：${JSON.stringify(ja)}`);
  assert.ok(ja.some((r) => r === '有本地化文档，但不是中文'), JSON.stringify(ja));
  // ③ 两样都没有 → 这一条根本不出现（我们没查到，就不下结论）。
  const none = buildReasons({ score: { parts: { installPath: 18, chinese: 0 } }, runnability: { kind: 'releaseWindows' } });
  assert.ok(!none.some((r) => r.includes('中文')), JSON.stringify(none));
  // ④ 分数说 7 分、却一个事实都没给 → 也不许凭空说"有中文说明"（这条最接近原来的缺陷）。
  const bogus = buildReasons({ score: { parts: { installPath: 18, chinese: 7 } } });
  assert.ok(!bogus.some((r) => r.includes('有中文说明')), `分数不是事实：${JSON.stringify(bogus)}`);
});

test('已停止维护的项目给停机结论，许可证这条依然为真、照旧输出', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 8, release90d: 6, license: 4 } },
    repo: { pushedAt: new Date().toISOString(), archived: true },
    velocity: { gained7d: 500, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', hasChinese: true }
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
  }

  // R149：上面那三个 `rs.every(...)` 写在 `deepEqual(rs, [])` 之后，而空数组的 every 恒为 true ——
  // 它们是**空转**的（等于什么都没测）。要真的有鉴别力，必须喂一份**非空**的输出。
  // 这一份把所有能出理由的证据都给上：五个分支都会产出句子。
  const rich = buildReasons({
    score: { parts: { installPath: 18, chinese: 7, pushRecency: 8, license: 4 } },
    repo: { pushedAt: new Date().toISOString(), hasRelease90d: true },
    velocity: { gained7d: 1234, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', hasChinese: true },
  });
  assert.ok(rich.length >= 4, `这一份应当产出足够多的理由（实际 ${rich.length} 条），否则下面的断言又会空转`);
  assert.ok(rich.every((r) => typeof r === 'string' && r.trim() !== ''), '没有空字符串');
  assert.ok(rich.every((r) => !/\b(star|fork|issue)s?\b/i.test(r)), '没有行话');
  assert.ok(rich.every((r) => !/[a-z]+_[a-z]+/.test(r)), `没有字段名：${JSON.stringify(rich)}`);
  // 负面对照：证明上面那两条正则真的会命中（不是写错了所以永远为真）。
  assert.ok(/\bstar\b/i.test('本周新增 star 100'), '行话正则必须能命中');
  assert.ok(/[a-z]+_[a-z]+/.test('本周新增 stars_gained_7d'), '字段名正则必须能命中（下划线形式的字段名）');
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
    runnability: { kind: 'releaseWindows', hasChinese: true }
  });
  assert.ok(rs.length >= 3, '信息充足时至少 3 条');
  assert.ok(rs.length <= 5, '不超过 5 条');
  assert.equal(new Set(rs).size, rs.length, '不重复');
});
