import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReputation, scoreRepo, passesGates } from '../src/score/score.mjs';
import { DETAIL_WEIGHTS, WEIGHTS } from '../src/config/weights.mjs';

const base = { ownerRepo:'a/b', stars:1000, forks:150,
  pushedAt: new Date().toISOString(), license:'MIT', archived:false, language:'Go', hasRelease90d:true };

test('各子项满分时口碑分等于 30', () => {
  assert.equal(scoreReputation(base, { growing: true }).total, 30);
});

test('口碑五项之和恰等于 WEIGHTS.reputation = 30', () => {
  // 这条是护栏：日后有人改了某一项的分值却忘了总和，这里会先失败。
  assert.equal(Object.values(DETAIL_WEIGHTS).reduce((a, b) => a + b, 0), WEIGHTS.reputation);
  assert.equal(WEIGHTS.reputation, 30);
});

test('口碑子项里不再有 issue 处理率（closed_issues 在真实 API 里根本不存在）', () => {
  const r = scoreReputation({ ...base, openIssues: 80, closedIssues: 20 }, { growing: false });
  assert.equal('issueClosure' in r.parts, false);
  assert.deepEqual(Object.keys(r.parts).sort(),
    ['forkRatio', 'growth', 'license', 'pushRecency', 'release90d']);
});

test('fork/star 比按 0.15 线性折算，达到 0.15 即满分 8', () => {
  assert.equal(scoreReputation({ ...base, stars: 1000, forks: 150 }, { growing: true }).parts.forkRatio,
    DETAIL_WEIGHTS.forkRatio);
  // 0.075 / 0.15 = 一半 → 4 分
  assert.equal(scoreReputation({ ...base, stars: 2000, forks: 150 }, { growing: true }).parts.forkRatio, 4);
});

test('新项目没有历史增长数据时不惩罚，给中性分', () => {
  const r = scoreReputation(base, { growing: null });
  assert.equal(r.parts.growth, 2);         // 4 分的一半
});

// R40：release90d 的三种状态必须分开记分——"问到没有"才是 0，"没问到"给中性半分。
// 把未知记 0 会让界面显示"近 90 天有发版：0 分"，那是一句我们没有证据的话。
test('发版信息未知时不惩罚，给中性半分；确认没发版才记 0（R40）', () => {
  const unknown = scoreReputation({ ...base, hasRelease90d: null }, { growing: true });
  assert.equal(unknown.parts.release90d, DETAIL_WEIGHTS.release90d / 2);   // 6 / 2 = 3
  const none = scoreReputation({ ...base, hasRelease90d: false }, { growing: true });
  assert.equal(none.parts.release90d, 0);
});

test('archived 仓库被门槛挡下并给出原因', () => {
  const g = passesGates({ ...base, archived: true }, { kind:'npmBinWin', verified:true });
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(','), /停止维护/);
});

test('无许可证 / 收藏不足 / 无已核实安装路径分别被挡下', () => {
  assert.equal(passesGates({ ...base, license:null }, { kind:'npmBinWin', verified:true }).ok, false);
  assert.equal(passesGates({ ...base, stars:50 }, { kind:'npmBinWin', verified:true }).ok, false);
  assert.equal(passesGates(base, { kind:'npmBinWin', verified:false }).ok, false);
});

test('超过 7 天没提交被门槛挡下', () => {
  const old = { ...base, pushedAt: '2026-09-01T00:00:00Z' };
  assert.equal(passesGates(old, { kind:'npmBinWin', verified:true }, new Date('2026-10-10T00:00:00Z')).ok, false);
});

// 以下为简报之外的补充用例：简报没有覆盖 scoreRepo 汇总与"一次列全部原因"，
// 而这两点是本任务的硬要求（Task 5 要读 score.parts.installPath / chinese）。
test('scoreRepo 汇总三轴分数并透传 grade 与 confidence', () => {
  const s = scoreRepo({
    repo: base,
    runnability: { kind:'releaseWindows', verified:true, chineseDoc:true },
    velocity: { gained7d: 3000, confidence: 'measured' },
    extra: { growing: true },
  }, new Date());
  assert.equal(s.hot, 45);
  assert.equal(s.reputation, 30);
  assert.equal(s.runnable, 25);
  assert.equal(s.total, 100);
  assert.equal(s.grade, 'green');
  assert.equal(s.confidence, 'measured');
  assert.equal(s.parts.installPath, 18);
  assert.equal(s.parts.chinese, 7);
});

test('scoreRepo 的 parts 同时带上口碑子项，total 等于三轴之和', () => {
  const s = scoreRepo({
    repo: base,
    runnability: { kind:'npmBinWin', verified:true, chineseDoc:false },
    velocity: { gained7d: 0, confidence: 'estimated' },
    extra: { growing: null },
  }, new Date());
  assert.equal('issueClosure' in s.parts, false);
  assert.equal(s.parts.release90d, DETAIL_WEIGHTS.release90d);
  assert.equal(s.parts.growth, 2);
  assert.equal(s.total, s.hot + s.reputation + s.runnable);
});

test('六条门槛全过时 ok 为 true 且不给原因', () => {
  assert.deepEqual(passesGates(base, { kind:'npmBinWin', verified:true }, new Date()), { ok: true, reasons: [] });
});

test('门槛会把所有未通过项一次说清，不只报第一条', () => {
  const bad = { ...base, archived:true, license:null, stars:50, language:'',
    pushedAt:'2026-09-01T00:00:00Z', ownerRepo:'awesome/list-only' };
  const g = passesGates(bad, { kind:'none', verified:false }, new Date('2026-10-10T00:00:00Z'));
  assert.equal(g.ok, false);
  assert.deepEqual(g.reasons, [
    '已停止维护',
    '没有开源许可证',
    '超过 7 天没有更新',
    '收藏人数不足 200',
    '没有已核实的安装方式',
    '这是资料清单，不是能装的软件',
  ]);
});

test('清单类只按语言与安装路径判，名字里带 awesome 的真工具必须放行', () => {
  // 有语言、有已核实安装路径 → 是能装的软件，名字再像清单也不算清单类。
  const tool = { ...base, ownerRepo:'awesome-tool/cli', language:'Go' };
  assert.equal(passesGates(tool, { kind:'npmBinWin', verified:true }, new Date()).ok, true);
  // 没有语言（或只有 Markdown）又没有安装路径 → 才判为清单类。
  for (const language of ['', null, 'Markdown']) {
    const list = { ...base, ownerRepo:'awesome/list-only', language };
    const g = passesGates(list, { kind:'none', verified:false }, new Date());
    assert.equal(g.ok, false);
    assert.ok(g.reasons.includes('这是资料清单，不是能装的软件'), `language=${String(language)} 应被判为清单类`);
  }
});

test('语言为空但有已核实安装路径的项目不算清单类', () => {
  assert.deepEqual(passesGates({ ...base, language:'' }, { kind:'dockerOnly', verified:true }, new Date()),
    { ok: true, reasons: [] });
});

test('未知 kind 与 none 一样被门槛挡下，dockerOnly 这类真实路径仍放行', () => {
  assert.equal(passesGates(base, { kind:'奇怪的kind', verified:true }, new Date()).ok, false);
  assert.equal(passesGates(base, { kind:'none', verified:true }, new Date()).ok, false);
  assert.equal(passesGates(base, { kind:'dockerOnly', verified:true }, new Date()).ok, true);
});
