import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from '../src/boards/build.mjs';
import { BOARD_SIZES } from '../src/config/weights.mjs';
import { passesGates } from '../src/score/score.mjs';
import candidates from '../fixtures/candidates.json' with { type: 'json' };

const NOW = new Date('2026-10-10T00:00:00Z');

// 门槛挡下的五个候选：前四个各自只违反一条门槛，awesome/list-only 同时违反门槛 5 与门槛 6。
const BLOCKED = ['bad/archived', 'bad/nolicense', 'bad/unverified', 'bad/stale', 'awesome/list-only'];

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

test('纯清单类被门槛挡在新手榜外，但仍进经典榜', () => {
  const newbie = buildBoard('newbie', candidates, NOW).map((x) => x.repo.ownerRepo);
  const classic = buildBoard('classic', candidates, NOW).map((x) => x.repo.ownerRepo);
  // awesome/list-only 是被门槛 5（没有已核实的安装方式）与门槛 6（spec §6.4 资料清单）
  // 一起挡下的，不是被"新手榜专属过滤器"挡下的——代码里没有那样的过滤器。
  assert.ok(!newbie.includes('awesome/list-only'));
  assert.ok(classic.includes('awesome/list-only'));
});

test('R142：资料清单那一条不新增任何排除（它不会让多一个项目落榜）', () => {
  // 文档（README 与手册）现在写的是"五条门槛 + 资料清单只是给同一批被挡下的项目一个更准确的说明"。
  // 这条断言把这个说法钉在代码上。注意 passesGates 是**把所有不通过的原因都列出来**、不短路，
  // 所以"资料清单"那句会与"没有已核实的安装方式"同时出现——那正是"更准确的说明"的意思。
  // 真正要证明的是：**它不会让多一个项目落榜**。
  const base = {
    name: 'x', stars: 5000, forks: 100, language: null,
    license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false,
  };
  const cases = [
    // 除安装方式外全都合格：三个都只因为"没有已核实的安装方式"被挡。
    { repo: { ...base, ownerRepo: 'a/none-kind' }, runnability: { kind: 'none', verified: true } },
    { repo: { ...base, ownerRepo: 'b/unverified' }, runnability: { kind: 'releaseWindows', verified: false } },
    { repo: { ...base, ownerRepo: 'c/unknown-kind' }, runnability: { kind: 'something-new', verified: true } },
    // 语言不是 Markdown 的同一批：证明"语言"本身不参与判据（判据要的是"语言空/Markdown **且**没有安装方式"）。
    { repo: { ...base, ownerRepo: 'd/none-with-lang', language: 'Go' }, runnability: { kind: 'none', verified: true } },
  ];
  for (const c of cases) {
    const verdict = passesGates(c.repo, c.runnability, NOW);
    assert.equal(verdict.ok, false, `${c.repo.ownerRepo} 应当被挡下`);
    assert.ok(verdict.reasons.includes('没有已核实的安装方式'), `${c.repo.ownerRepo} 应当因为门槛 5 被挡下`);
    // "资料清单"那句只允许出现在**已经**因为门槛 5 被挡下的候选身上。
    if (verdict.reasons.includes('这是资料清单，不是能装的软件')) {
      assert.ok(verdict.reasons.includes('没有已核实的安装方式'),
        `${c.repo.ownerRepo} 被"资料清单"单独挡下了——那它就不再是门槛 5 的子集，文档的说法要跟着改`);
      assert.ok(!c.repo.language || c.repo.language === 'Markdown',
        `${c.repo.ownerRepo} 的语言不是空/Markdown 却被判成资料清单`);
    }
  }
  // 反向对照：真有安装方式的仓库，无论语言是不是 Markdown，都必须放行。
  // （这一条同时证明"语言是 Markdown"本身不是门槛——否则上面那种"子集"的说法就不成立。）
  const md = { ...base, ownerRepo: 'e/markdown-tool', language: 'Markdown' };
  assert.equal(passesGates(md, { kind: 'npmBinWin', verified: true }, NOW).ok, true,
    '有安装方式的 Markdown 仓库必须能进榜（否则"资料清单"就不只是门槛 5 的子集）');
  const noLang = { ...base, ownerRepo: 'f/no-lang-exe', language: null };
  assert.equal(passesGates(noLang, { kind: 'releaseWindows', verified: true }, NOW).ok, true,
    '没有标注语言但有安装包的仓库也必须能进榜');
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
      // extra 于 Task 15 随 R41 加入：`extra.growing` 是"我们问没问到收藏在增长"的三态事实，
      // 导出层要照实写进 JSON 给界面看，所以它必须跟着条目走出 buildBoard。
      // R153：`chineseDoc` 这个与 `hasChinese` 恒等的历史名已删除（同一事实只留一个名字）。
      ['extra', 'grade', 'hasChinese', 'rank', 'reasons', 'repo', 'runnability', 'score', 'velocity'],
    );
    assert.ok(Array.isArray(x.reasons));
    assert.ok(x.reasons.every((r) => typeof r === 'string' && r.length > 0));
  }
  const top = w[0];
  assert.equal(top.repo.ownerRepo, 'gamma/pdfsmith');
  assert.equal(top.hasChinese, true);
  assert.equal(top.grade, 'green');
  assert.ok(top.reasons.length >= 1);
  // 新手榜先按新手友好分排，满分 25 的候选有四个（同分时码点序最前的是 'Zed/x'，但它只有 21 分）。
  const newbie = buildBoard('newbie', candidates, NOW);
  assert.equal(newbie[0].repo.ownerRepo, 'epsilon/shrinkvid');
  assert.equal(newbie[0].score.runnable, 25);
});

test('没有标注语言但有已核实安装路径的仓库，两个榜都进', () => {
  // zeta/no-lang-exe 的 language 是 null，但它有已核实的 releaseWindows 安装包，六条门槛全过。
  // 门槛不过问语言字段，所以它必须同时出现在周榜与新手榜；若哪天有人给新手榜再加一道
  // "语言不能为空"的过滤器，这条断言就会失败（spec §6.4 的清单类判定是合取，
  // 且只由 passesGates 一处实现）。
  const w = buildBoard('weekly', candidates, NOW).map((x) => x.repo.ownerRepo);
  const n = buildBoard('newbie', candidates, NOW).map((x) => x.repo.ownerRepo);
  assert.equal(candidates.find((c) => c.repo.ownerRepo === 'zeta/no-lang-exe').repo.language, null);
  assert.ok(w.includes('zeta/no-lang-exe'), '有已核实安装包就该留在周榜');
  assert.ok(n.includes('zeta/no-lang-exe'), '有已核实安装包就该进新手榜');
});

test('同分回退用码点比较，不依赖运行时语言环境', () => {
  // 大小写混合时 localeCompare 会给出与码点不同的顺序（实测 'Zed/x'.localeCompare('apple/y') === 1），
  // 那样换一台机器或换一个 Node 构建就可能排出不同榜单。这里要求码点序：大写字母在小写字母之前。
  const b = buildBoard('weekly', candidates, NOW);
  const zed = b.findIndex((x) => x.repo.ownerRepo === 'Zed/x');
  const apple = b.findIndex((x) => x.repo.ownerRepo === 'apple/y');
  assert.notEqual(zed, -1, 'Zed/x 应出现在周榜里');
  assert.notEqual(apple, -1, 'apple/y 应出现在周榜里');
  assert.equal(b[zed].score.total, b[apple].score.total, '两个对照项目的总分必须相同');
  assert.ok(zed < apple, '码点序下 Zed/x 必须排在 apple/y 之前');
});
