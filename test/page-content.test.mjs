// 页面内容与纯渲染逻辑的测试。
//
// 两层断言：
//   ① 静态文件断言（简报钉住的那几条）—— 首页不得出现行话、三个榜签与筛选条文案必须在、
//      app.js 必须渲染"估算 / 实测"并引用新手准备页；
//   ② 纯渲染函数断言 —— 真正会被用户看到的那些字必须诚实：
//      R25 经典榜不得出现三轴分数条 / R64 徽章只认 hasChinese / 置信度三种说法照实标注 /
//      velocitySource === 'none' 不得渲染成"涨 0" / 空榜与降级提示是第一等状态 /
//      evidence 原始英文值不得出现在用户可见文案里。
//
// 渲染逻辑住在 public/render.mjs：它不碰 DOM、不读时钟、不发请求，输入 JSON 里的条目、输出 HTML 字符串，
// 所以能在 node:test 里直接跑，不需要浏览器。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStaticServer } from '../src/http/static-server.mjs';
import {
  CHINESE_BADGE,
  LOCALIZED_ONLY_BADGE,
  boardAcceptsDifficultyFilter,
  boardNotice,
  boardScore,
  buildBoardView,
  boardNote,
  chineseBadge,
  confidenceNotice,
  degradedNotice,
  difficultyBadge,
  difficultyFilterHint,
  escapeAttr,
  escapeHtml,
  evidenceNotice,
  factsForBoard,
  growthNotice,
  itemCard,
  itemMeta,
  noDataNotice,
  scoreBars,
} from '../public/render.mjs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

/**
 * 去掉注释后的源码，用来断言"用户可见文案"。
 * 为什么必须去注释：注释里会引用禁令原文（例如"不能承诺点开就能看安装说明"），
 * 那不是文案，直接扫全文会把正确的注释判成违规。真正的风险恰恰是"有人照注释抄进模板串"，
 * 那一步会留在代码里，被这些断言抓住。
 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/** 造一条榜单条目：只给测试关心的字段，其余交给默认值。 */
const item = (extra = {}) => ({ ownerRepo: 'demo/tool', name: 'tool', rank: 1, ...extra });

// ---------- ① 静态文件断言（简报原文，一条不削弱） ----------

test('首页不得出现 star / fork / issue 行话', () => {
  const html = read('index.html').toLowerCase();
  assert.ok(!/\bstar\b|\bfork\b|\bissue\b/.test(html));
});

test('首页含三个榜签与筛选条文案', () => {
  const html = read('index.html');
  assert.match(html, /本周飙升/);
  assert.match(html, /新手能玩/);
  assert.match(html, /经典必玩/);
  assert.match(html, /一键就能玩/);
  assert.match(html, /有中文说明/);
});

test('置信度文案与三步向导：页面明说三种说法，且引用新手准备页', () => {
  // 三种置信度的说明现在是页面上的正文（页脚那段），所以断言落在用户真正读到的文件上。
  const html = read('index.html');
  assert.match(html, /估算/);
  assert.match(html, /实测/);
  assert.match(html, /GitHub 官方数据/);

  // 新手准备页的链接在提示语里（render.mjs），"还在做 / 下个版本"的实话在两边都有：
  // 两个文件一起看——只看一个文件正是 R105 里那句话溜过去的原因。
  assert.match(read('render.mjs'), /prepare\.html/);
  assert.match(stripComments(read('render.mjs') + read('app.js')), /还在做|下一个版本/);
  assert.match(read('app.js'), /下一个版本/);
});

test('首页引入渲染模块，app.js 真的用它渲染（不是只写在注释里）', () => {
  assert.match(read('index.html'), /type="module"[^>]*src="\.?\/?app\.js"/);
  const js = read('app.js');
  assert.match(js, /from '\.\/render\.mjs'/);
  // app.js 自己必须真的调用渲染函数、走状态函数（R93），而不是留一句"以后要渲染"的注释。
  assert.match(js, /itemCard\(\{/);
  assert.match(js, /buildBoardView\(\{/);
  assert.match(js, /computeView\(/);
});

// ---------- ② 行话禁令（spec §4.3，产品约束） ----------

/** 渲染一条条目在所有可见位置上的文本，用来整体扫行话与字段名泄漏。 */
function renderedText(boardId, item) {
  return [
    itemMeta({ boardId, item }),
    boardScore(boardId, item),
    scoreBars(boardId, item),
    itemCard({ boardId, item }),
    growthNotice(item.velocity).text,
    confidenceNotice(item.velocity),
    evidenceNotice(item.install?.evidence),
    ...JSON.stringify(factsForBoard(boardId, item)),
  ].join('\n');
}

test('渲染层任何用户可见文案都不得出现行话', () => {
  const source = read('render.mjs');
  // 先证明"扫到东西了"：否则字符串被抽空或正则写错时，这条断言会空转成永久绿。
  assert.ok(source.length > 2000);
  assert.ok(source.includes('本周新增收藏'));

  // 注释里也不许留着行话原词：下一个人复制粘贴时就可能顺手把它带进界面文案。
  const comments = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? [];
  assert.ok(comments.length > 10, '没扫到注释，正则写错了');
  for (const comment of comments) {
    assert.ok(!/\bstar\b|\bfork\b|\bissue\b|archived|\bcommit\b|\bmerge\b|\brepo\b/i.test(comment), `注释里残留了行话：${comment.slice(0, 60)}`);
  }

  // 代码部分只扫字符串与模板串：读 JSON 的字段名（readsArchived 那种形态）不是给用户看的文案。
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const literals = code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? [];
  assert.ok(literals.length > 10, '没扫到字符串字面量，正则写错了');
  for (const literal of literals) {
    assert.ok(!/\bstar\b|\bfork\b|\bissue\b|archived|\bcommit\b|\bmerge\b|\brepo\b/i.test(literal), `文案里残留了行话：${literal.slice(0, 60)}`);
  }
});

test('真正渲染出来的文本不得出现字段名或英文行话', () => {
  // 全字段都填上的条目：所有可见位置一起扫，比逐个函数断言更难糊弄过去。
  const nasty = item({
    rank: 3,
    ownerRepo: 'demo/tool',
    name: 'tool',
    description: '一个把 PDF 变成文字的小工具',
    language: 'Python',
    license: 'MIT',
    stars: 12345,
    forks: 678,
    starsGained7d: 900,
    starsGained3d: 120,
    confidence: 'estimated',
    velocitySource: 'events',
    grade: 'yellow',
    chineseDoc: true,
    hasChinese: true,
    localizedFiles: ['README.ja.md'],
    archived: true,
    pushedAt: '2026-10-08T00:00:00Z',
    hasRelease90d: true,
    growing: true,
    scores: { hot: 45, reputation: 30, runnable: 25, total: 100, installPath: 18, chinese: 8, release90d: 4, growth: 10, forkRatio: 3, pushRecency: 7, license: 2 },
    install: { kind: 'pypiCompatible', command: 'pip install tool', downloadUrl: null, evidence: 'project_urls', verified: true, requiresPython: '>=3.10', steps: [], faq: [] },
    reasons: ['本周新增收藏约 900（估算）', '有中文说明，照着做不容易卡住'],
    velocity: { gained7d: 900, gained3d: 120, confidence: 'estimated', source: 'events', level: 4 },
  });

  for (const boardId of ['weekly', 'newbie', 'classic']) {
    const text = renderedText(boardId, nasty);
    assert.ok(!/\bstar\b|\bfork\b|\bissue\b|archived|\bcommit\b|\bmerge\b|\brepo\b/i.test(text), `${boardId} 渲染结果里出现了行话`);
    assert.ok(!/stars_gained_7d|localized_files|owner_repo|install_path/i.test(text), `${boardId} 渲染结果里出现了字段名`);
    // 赋值键与取证枚举值是上游契约，不在这里断言：渲染层不得把它们写进正文（由上面两条覆盖）。
  }
});

// ---------- ③ R25：经典榜不渲染三轴分数 ----------

test('R25：经典必玩榜不渲染三轴分数，改说总收藏与最后更新', () => {
  const classic = item({ stars: 123456, pushedAt: '2026-10-08T00:00:00Z', scores: { hot: 45, reputation: 30, runnable: 25, total: 100 } });
  assert.equal(boardScore('classic', classic), '');

  const facts = factsForBoard('classic', classic);
  assert.match(facts.map((f) => f.label).join(' '), /总收藏/);
  assert.match(facts.map((f) => f.label).join(' '), /最后更新/);
  assert.ok(!/三轴|热度|口碑|新手友好/.test(JSON.stringify(facts)), '经典榜不得出现评分轴的说法');
});

test('R25：周榜与新手榜才渲染三轴分数摘要', () => {
  const weekly = item({ scores: { hot: 45, reputation: 30, runnable: 25, total: 100 } });
  assert.match(boardScore('weekly', weekly), /热度/);
  assert.match(boardScore('weekly', weekly), /100/);
  assert.match(boardScore('newbie', weekly), /新手友好/);
});

// ---------- ④ R64：中文徽章必须诚实 ----------

test('R64：只有 hasChinese === true 才显示「有中文说明」', () => {
  // 徽章是 HTML 片段（带样式类），所以断言"包含"而不是"等于"整串。
  const trueBadge = chineseBadge(item({ hasChinese: true }));
  assert.ok(trueBadge.includes(CHINESE_BADGE));

  const jaBadge = chineseBadge(item({ hasChinese: false, localizedFiles: ['README.ja.md'] }));
  assert.ok(jaBadge.includes(LOCALIZED_ONLY_BADGE));
  assert.ok(!jaBadge.includes(CHINESE_BADGE));
  assert.ok(!LOCALIZED_ONLY_BADGE.includes('中文说明'));
  assert.match(LOCALIZED_ONLY_BADGE, /非中文/);
  // 没有本地化文件时两个徽章都不给：我们不知道，就不说。
  assert.equal(chineseBadge(item({ hasChinese: false })), '');
});

test('R64：只有日文文档的条目在渲染结果里绝不出现「有中文说明」', () => {
  const html = itemMeta({ boardId: 'weekly', item: item({ hasChinese: false, localizedFiles: ['README.ja.md'] }) });
  assert.ok(!html.includes(CHINESE_BADGE));
  assert.ok(html.includes(LOCALIZED_ONLY_BADGE));
});

// ---------- ⑤ 置信度必须可见，且不知道就不说 ----------

test('置信度三种说法照实标注，未知不得渲染成「涨 0」', () => {
  const measured = { gained7d: 1234, confidence: 'measured', source: 'history-json' };
  const reported = { gained7d: 1200, confidence: 'reported', source: 'trending' };
  const estimated = { gained7d: 900, confidence: 'estimated', source: 'events' };
  const none = { gained7d: 0, confidence: 'estimated', source: 'none' };

  assert.match(growthNotice(measured).text, /实测/);
  assert.match(growthNotice(measured).text, /1,234/);
  assert.match(growthNotice(reported).text, /GitHub 官方数据/);
  assert.match(growthNotice(estimated).text, /约 900（估算）/);

  const unknown = growthNotice(none);
  assert.equal(unknown.known, false);
  assert.equal(unknown.text, '');
  assert.ok(!unknown.text.includes('0'), '没有数据时不得渲染成涨 0');
  assert.equal(growthNotice(undefined).known, false);
  assert.equal(growthNotice({ gained7d: null }).known, false);
});

test('近 3 日新增只在真有数据时出现', () => {
  const measured = { gained7d: 400, confidence: 'measured', source: 'stargazers-history' };
  const with3d = confidenceNotice({ ...measured, gained3d: 120 });
  assert.match(with3d, /近 3 日新增 120/);
  assert.match(with3d, /实测/);
  const without = confidenceNotice({ ...measured, gained3d: null });
  assert.equal(without, '');
  // 数据源是 none（我们根本没问到）时，7 日与 3 日两行都不许出现。
  assert.equal(confidenceNotice({ gained3d: 120, confidence: 'estimated', source: 'none' }), '');
});

// ---------- ⑥ evidence 不得原样出现 ----------

test('evidence 的英文原始值绝不出现，且给出中文说法', () => {
  for (const raw of ['repository', 'bugs.url', 'homepage', 'project_urls', 'home_page', 'none']) {
    const notice = evidenceNotice(raw);
    assert.ok(!notice.includes(raw), `不得原样显示 ${raw}`);
    assert.match(notice, /[\u4e00-\u9fa5]/, `${raw} 应有一句中文说法`);
  }
});

// ---------- ⑦ 空榜与降级是第一等状态 ----------

test('扁平的顶层速度字段也要认，source 为 none 时卡片上不许出现「新增收藏 0」', () => {
  // collector 写的 JSON 是扁平字段（starsGained7d / confidence / velocitySource），
  // 这里用真实形状的条目钉住"我们没问到"不会被渲染成一个数字。
  const unknown = itemMeta({
    boardId: 'weekly',
    item: item({ grade: 'green', starsGained7d: 0, starsGained3d: null, confidence: 'estimated', velocitySource: 'none' }),
  });
  assert.ok(!unknown.includes('新增收藏 0'), '没问到的时候不得渲染成新增 0');
  assert.match(unknown, /没有查到/);

  const known = itemMeta({
    boardId: 'weekly',
    item: item({ grade: 'green', starsGained7d: 2500, confidence: 'reported', velocitySource: 'trending' }),
  });
  assert.match(known, /2,500/);
  assert.match(known, /GitHub 官方数据/);
});

test('空榜与降级都有中文提示，且 missing / degraded 分开说', () => {
  const missing = boardNotice({ boardTitle: '本周飙升', itemCount: 0 });
  assert.match(missing, /暂时没有/);

  const degraded = degradedNotice(true);
  assert.match(degraded, /数据不完整/);
  assert.equal(degradedNotice(false), '');

  // 空榜提示不能把"没有条目"说成"采集失败"：两件事原因不同，文案也不能混。
  assert.ok(!missing.includes('不完整'));
});

// ---------- ⑧ 难度徽章与卡片元信息 ----------

test('难度徽章用 spec §4.2 的三档文案', () => {
  assert.match(difficultyBadge('green'), /一键就能玩/);
  assert.match(difficultyBadge('yellow'), /要几步/);
  assert.match(difficultyBadge('red'), /要懂点技术/);
});

test('卡片元信息给出难度、中文与增长，且不含分数条（卡片上不放三轴明细）', () => {
  const html = itemMeta({
    boardId: 'weekly',
    item: item({ grade: 'green', hasChinese: true, velocity: { gained7d: 500, confidence: 'measured', source: 'history-json' } }),
  });
  assert.match(html, /一键就能玩/);
  assert.match(html, /有中文说明/);
  assert.match(html, /实测/);
  assert.ok(!html.includes('热度'), '卡片上不放三轴明细，那是详情里的东西');
});

// ---------- ⑨ 状态计算：该显示哪些条目、该给哪些提示（R93–R101） ----------
//
// 这一组是本文件里最重要的部分：以前"切榜单 / 改筛选 / 换日期之后会怎样"只能在浏览器里点着看，
// 而沙箱起不了浏览器，于是 R94–R97、R100、R101 那几条缺陷全都溜了过去。
// 现在这些判断都住在 render.mjs 的 buildBoardView 里（无 DOM），所以能在这里断言。

/** 造一天的日报数据。 */
const daily = (extra = {}) => ({ date: '2026-10-10', degraded: false, notes: [], boards: [], ...extra });

/** 按 id 找一个通知（找不到返回 null）。 */
const noticeOf = (view, key) => view.notices.find((n) => n.key === key) ?? null;

/** 三条难度不同的条目，用来验筛选。 */
const threeItems = () => [
  item({ ownerRepo: 'a/one', name: 'one', rank: 1, grade: 'green', hasChinese: true, language: 'Python', stars: 100 }),
  item({ ownerRepo: 'b/two', name: 'two', rank: 2, grade: 'yellow', hasChinese: false, language: 'Go', stars: 200 }),
  item({ ownerRepo: 'c/three', name: 'three', rank: 3, grade: 'red', hasChinese: false, language: 'Go', stars: 300 }),
];

test('R94：degraded 通知由状态函数产出，切榜单/改筛选/换日期之后都还在', () => {
  const items = threeItems();
  const notes = ['trending 页面没抓到'];
  // 用户视角的三次"点一下"：切到新手榜、勾上难度筛选、换到另一天。三次都重新算一遍视图。
  const base = { items, notes, daily: daily({ degraded: true, notes }) };

  const weekly = buildBoardView({ ...base, boardId: 'weekly' });
  assert.match(noticeOf(weekly, 'degraded').html, /数据不完整/);
  assert.match(noticeOf(weekly, 'degraded').html, /trending 页面没抓到/);

  const newbie = buildBoardView({ ...base, boardId: 'newbie' });
  assert.ok(noticeOf(newbie, 'degraded') !== null, '切榜单之后 degraded 通知必须还在');

  const filtered = buildBoardView({ ...base, boardId: 'weekly', filters: { easy: true } });
  assert.ok(noticeOf(filtered, 'degraded') !== null, '改筛选之后 degraded 通知必须还在');

  const otherDay = buildBoardView({ ...base, boardId: 'classic', filters: { language: 'Go' } });
  assert.ok(noticeOf(otherDay, 'degraded') !== null, '换日期/换筛选之后 degraded 通知必须还在');

  // 换到数据完整的那一天，通知必须消失（不能一直挂着）。
  const healthy = buildBoardView({ items, daily: daily({ degraded: false }), boardId: 'weekly' });
  assert.equal(noticeOf(healthy, 'degraded'), null);
});

test('R94：notes 缺失也要能渲染 degraded（不能因为少了 notes 就不提示）', () => {
  const view = buildBoardView({ items: threeItems(), boardId: 'weekly', daily: daily({ degraded: true }) });
  const notice = noticeOf(view, 'degraded');
  assert.ok(notice !== null);
  assert.match(notice.html, /数据不完整/);
});

test('R95：语言清单来自当期真实数据，且语言筛选真的过滤条目', () => {
  const items = threeItems();
  const view = buildBoardView({ items, boardId: 'weekly' });
  // 稳定排序（Go 在 Python 前面），不是数据里的出现顺序。
  assert.deepEqual(view.languages, ['Go', 'Python']);
  assert.equal(view.unknownLanguageCount, 0);

  const go = buildBoardView({ items, boardId: 'weekly', filters: { language: 'Go' } });
  assert.equal(go.items.length, 2);
  assert.ok(go.items.every((i) => i.language === 'Go'));

  // 认不出语言的项目也要能被单独筛出来，否则它们在"全部语言"里混着说不清。
  const mixed = [...items, item({ ownerRepo: 'd/four', name: 'four', rank: 4, language: null })];
  const mixedView = buildBoardView({ items: mixed, boardId: 'weekly' });
  assert.equal(mixedView.unknownLanguageCount, 1);
  const unknownOnly = buildBoardView({ items: mixed, boardId: 'weekly', filters: { language: '__unknown__' } });
  assert.equal(unknownOnly.items.length, 1);
  assert.equal(unknownOnly.items[0].name, 'four');
});

test('R95：app.js 真的调用了语言下拉渲染（不能只是定义在那里）', () => {
  const js = read('app.js');
  assert.match(js, /renderLanguageOptions\(/);
  // 定义一处 + 至少一处调用。
  assert.ok(js.split('renderLanguageOptions(').length >= 3, '语言下拉必须被真的调用，而不是只定义');
});

test('R96：经典榜忽略难度筛选，切过去以后条目数不变', () => {
  const items = threeItems();
  const filters = { easy: true };
  const weekly = buildBoardView({ items, boardId: 'weekly', filters });
  assert.equal(weekly.items.length, 1, '周榜上难度筛选照常生效');

  const classic = buildBoardView({ items, boardId: 'classic', filters });
  assert.equal(classic.items.length, items.length, '经典榜不参与评分，难度筛选对它不生效');
  assert.equal(boardAcceptsDifficultyFilter('classic'), false);
  assert.equal(boardAcceptsDifficultyFilter('weekly'), true);
  assert.equal(boardAcceptsDifficultyFilter('newbie'), true);
});

test('R97：页面文案不得声称"点开就能看到三步安装说明"', () => {
  // 这句检查是 R105 的前身：当时只扫了 app.js，结果 render.mjs 卡片上那句承诺溜了过去。
  // 现在两个文件都扫，而且只看**代码**（注释里引用那条禁令本身不算文案）。
  for (const [name, source] of Object.entries({ 'app.js': read('app.js'), 'render.mjs': read('render.mjs') })) {
    const code = stripComments(source);
    // 断言必须精确：粗糙的 /点开.*三步/ 会命中那句本来就在如实说明"还在做"的话，把正确的文案判成错的。
    // 注意 app.js 里那句实话用的是"下一个版本"（点击时弹的提示），render.mjs 用的是"还在做"（列表上方说明）。
    assert.ok(!/点开[^。；\n：]{0,20}(可以看到|就能看到|可查看|即可看到)[^。；\n]{0,20}三步安装说明/.test(code),
      `${name} 里承诺了还不存在的抽屉`);
    assert.match(code, /还在做|下一个版本/, `${name} 要说清"还在做"，而不是含糊其辞`);
  }
});

test('R98：外部输入进 HTML 前一律转义（属性与正文两条通道）', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; \'y\'&lt;/b&gt;');
  assert.equal(escapeAttr('a"b\'c<d'), 'a&quot;b&#39;c&lt;d');

  // 中文徽章里的文件名来自 README 检测（外部输入），必须转义。
  const badge = chineseBadge({ hasChinese: false, localizedFiles: ['README."ja".md'] });
  assert.ok(!badge.includes('"ja"'), '属性里的引号必须被转义');
  assert.match(badge, /&quot;/);

  // 描述里的 HTML 不能真的变成标签。
  const card = itemCard({ boardId: 'weekly', item: item({ description: '<img src=x onerror=alert(1)>' }) });
  assert.ok(!card.includes('<img'), '描述里的标签必须被转义，不能让原始串出现');
  assert.match(card, /&lt;img/);

  // 榜单名与条目里的项目全名也是同一份外部输入。
  const dailyTitle = buildBoardView({ items: threeItems(), boardId: 'weekly', boardTitle: '<b>坏榜名</b>' });
  assert.equal(dailyTitle.boardTitle, '<b>坏榜名</b>'); // 原样返回，转义由渲染方负责
  const dateOptions = ['2026-10-10" onmouseover="x'];
  assert.match(escapeAttr(dateOptions[0]), /&quot;/);
});

test('R99：无数据提示只给今天真能用的命令', () => {
  const notice = noDataNotice();
  assert.match(notice, /npm run collect --offline/);
  // `npm run demo` 今天是 `serve --demo`，而 serve 还不认识 --demo：不能指一条走不通的路。
  assert.ok(!notice.includes('npm run demo'), '不能推荐一条现在跑不通的命令');
  assert.match(notice, /还没有任何榜单数据/);
});

test('R100：统计文案说的是当前看得见的条数', () => {
  const items = threeItems();
  const all = buildBoardView({ items, boardId: 'weekly' });
  assert.equal(all.countText, '当前显示 3 个项目（这一榜共 3 个）');

  const filtered = buildBoardView({ items, boardId: 'weekly', filters: { easy: true } });
  assert.equal(filtered.visibleCount, 1);
  assert.equal(filtered.totalCount, 3);
  assert.match(filtered.countText, /当前显示 1 个项目/);
  assert.ok(!/^这一榜共 3 个项目$/.test(filtered.countText), '不能只报筛选前的总数');

  const empty = buildBoardView({ items: [], boardId: 'weekly', daily: daily() });
  assert.equal(empty.countText, '');
});

test('R101：boards 不是数组时给提示而不是抛错', () => {
  const broken = { date: '2026-10-10', degraded: false, boards: '不是数组' };
  // 以前这里会 TypeError，页面永远停在"正在读取榜单数据……"。
  const view = buildBoardView({ items: [], boardId: 'weekly', daily: broken });
  assert.match(noticeOf(view, 'broken').html, /读不出来/);
  assert.equal(view.items.length, 0);

  // items 本身不是数组、daily 是 null / 字符串，都不能抛。
  assert.doesNotThrow(() => buildBoardView({ items: null, boardId: 'weekly', daily: broken }));
  assert.doesNotThrow(() => buildBoardView({ items: 'x', boardId: 'weekly', daily: 'y' }));
  assert.doesNotThrow(() => buildBoardView({}));
  assert.doesNotThrow(() => buildBoardView());
  // 一天数据都没有时（dates 为空）才是"还没有任何榜单数据"；只有这一天读不到是另一句话（R104）。
  const noData = buildBoardView({ items: [], boardId: 'weekly', daily: null, dates: [] });
  assert.match(noticeOf(noData, 'no-data').html, /还没有任何榜单数据/);
});

test('R93：未知榜单名不会变成空白页（回落到中文提示）', () => {
  const view = buildBoardView({ items: [], boardId: 'nope', daily: daily() });
  assert.equal(view.boardTitle, '这个榜');
  assert.match(noticeOf(view, 'empty').html, /暂时没有可以展示的项目/);
});

// ---------- R102：显示决策必须全在纯函数层 ----------

test('R102：缺某天数据的提示由纯函数决定，且不再与"本期没有条目"重复出现', () => {
  const dates = ['2026-10-10', '2026-10-09'];
  const missing = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-09', dates });

  // 同一次事件只能给一条提示：以前 app.js 另外插一条，于是"缺这一天"与"本期没有条目"同时出现。
  assert.equal(missing.notices.length, 1);
  assert.equal(missing.notices[0].key, 'date-missing');
  assert.match(missing.notices[0].html, /2026-10-09/);
  assert.equal(noticeOf(missing, 'empty'), null);

  // 正在读的时候是另一句话（不能把"还没读完"说成"读不出来"）。
  const loading = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-09', dates, loading: true });
  assert.equal(loading.notices.length, 1);
  assert.equal(loading.notices[0].key, 'loading');
  assert.match(loading.notices[0].html, /正在读取/);

  // 榜单这一期确实没有条目（文件读到了，只是空的）：这时才说"暂时没有可以展示的项目"。
  const empty = buildBoardView({ boardId: 'weekly', items: [], daily: daily(), dates });
  assert.equal(empty.notices.length, 1);
  assert.equal(empty.notices[0].key, 'empty');
});

test('R104：只有一天数据时不得建议换一天', () => {
  const oneDate = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-10', dates: ['2026-10-10'] });
  assert.match(noticeOf(oneDate, 'date-missing').html, /2026-10-10/);
  assert.ok(!noticeOf(oneDate, 'date-missing').html.includes('换一天'), '只有一天数据时日期选择器是隐藏的，不能建议换一天');
  assert.match(noticeOf(oneDate, 'date-missing').html, /npm run collect --offline/);

  const manyDates = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-09', dates: ['2026-10-10', '2026-10-09'] });
  assert.match(noticeOf(manyDates, 'date-missing').html, /换一天/);
});

test('R102：经典榜那句筛选说明由纯函数给，app.js 不再自己写文案', () => {
  assert.equal(difficultyFilterHint('weekly'), '');
  assert.equal(difficultyFilterHint('newbie'), '');
  assert.match(difficultyFilterHint('classic'), /不参与评分/);
  assert.match(difficultyFilterHint('classic'), /不生效/);

  const classic = buildBoardView({ items: threeItems(), boardId: 'classic', daily: daily() });
  const hint = classic.hints.find((h) => h.key === 'difficulty-filter');
  assert.ok(hint !== undefined);
  assert.ok(hint.html.includes(difficultyFilterHint('classic')));

  const weekly = buildBoardView({ items: threeItems(), boardId: 'weekly', daily: daily() });
  assert.equal(weekly.hints.find((h) => h.key === 'difficulty-filter'), undefined);

  // app.js 里不许再出现**任何**用户可见文案（它只负责把纯函数给的字符串贴到 DOM 上）。
  // 注释里提到产品口径不算文案，所以只扫代码部分。
  // 注意：app.js 里那个 alert 文案带 https:// 链接，所以必须用 stripComments —— 逐行删 // 的写法
  // 会把 "//github.com…" 之后的正确代码也当注释删掉（我曾因此得到过假的"通过"）。
  const appCode = stripComments(read('app.js'));
  for (const copy of ['不参与评分', '一键就能玩', '过线之后', '最值得先看', '新手能玩', '本周飙升', '经典必玩', '口碑']) {
    assert.ok(!appCode.includes(copy), `app.js 不该自己写显示文案：${copy}`);
  }
  // 榜单说明文案住在 render.mjs，并且每个榜都有一句。
  assert.match(boardNote('weekly'), /热度/);
  assert.match(boardNote('newbie'), /新手友好/);
  assert.match(boardNote('classic'), /不参与评分/);
  assert.equal(boardNote('nope'), '');
});

test('R102：app.js 只剩取数与写 DOM，不再有"根据数据挑显示内容"的分支', () => {
  const js = read('app.js');
  const code = js.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  // 这些是显示决策的载体：挑文案、拼提示、算可见条目——都应该住在 render.mjs 里。
  for (const forbidden of ['missingDateNotice', 'boardNotice', 'filteredOutNotice', 'noDataNotice',
    'dataErrorNotice', 'loadingNotice', 'cardDetailHint', 'difficultyFilterHint', 'passesFilters']) {
    assert.ok(!code.includes(forbidden), `app.js 仍在自己做显示决策：${forbidden}`);
  }
  // 它该做的事只有这三样。
  assert.match(code, /buildBoardView\(\{/);
  assert.match(code, /itemCard\(\{/);
  assert.match(code, /innerHTML = /);
});

// ---------- R103：跨期切换后筛选状态与选项一致 ----------

test('R103：切到没有"未标注语言"的那一天，筛选状态与下拉选项必须一致', () => {
  const unknownItem = item({ ownerRepo: 'd/four', name: 'four', rank: 4, language: null });
  const withUnknown = buildBoardView({ items: [...threeItems(), unknownItem], boardId: 'weekly', filters: { language: '__unknown__' } });

  // 选中的这一项在这一期成立：筛选有效，正好筛出那一条。
  assert.equal(withUnknown.languageSelectionValid, true);
  assert.equal(withUnknown.visibleCount, 1);
  assert.equal(withUnknown.items[0].name, 'four');

  // 换到没有未标注语言的一期：该选项不再存在，选择随之失效。
  // 曾经的缺陷：这里仍判为"有效"，于是下拉显示空白、筛选却还在生效 → 空列表 + 用户看不到任何筛选。
  const withoutUnknown = buildBoardView({ items: threeItems(), boardId: 'weekly', filters: { language: '__unknown__' } });
  assert.equal(withoutUnknown.languageSelectionValid, false, '选项不存在时选择必须失效，好让 app.js 回退到"全部语言"');
  assert.equal(withoutUnknown.unknownLanguageCount, 0);

  // 会话状态也一起回到"全部语言"（app.js 的 renderLanguageOptions 就做这一件事）。
  const fallback = buildBoardView({ items: threeItems(), boardId: 'weekly', filters: {} });
  assert.equal(fallback.visibleCount, 3);
  assert.equal(fallback.languageSelectionValid, true);
  assert.equal(noticeOf(fallback, 'filtered-out'), null);

  // 普通语言同理：选中的语言在新一期不存在时也必须失效。
  const goneLanguage = buildBoardView({ items: threeItems(), boardId: 'weekly', filters: { language: 'Rust' } });
  assert.equal(goneLanguage.languageSelectionValid, false);

  assert.match(read('app.js'), /languageSelectionValid/, 'app.js 必须消费这个判断来回退选择');
});

// ---------- R105：不得承诺"点开就能看安装说明"（两个文件都扫） ----------

test('R105：全部用户可见文案都不得承诺"点开就能看安装说明 / 详细介绍"', () => {
  // 只扫 app.js 是上一版让这句话溜过去的原因：卡片上的文案其实在 render.mjs 里。
  // 这里把页面会出现的两个 JS 文件都扫一遍。注释里引用那条禁令本身不算文案，所以先去掉注释；
  // 真正的风险恰恰是"有人在注释里读到这句话、然后把它复制进模板串"，那一步会被抓住。
  const sources = { 'app.js': read('app.js'), 'render.mjs': read('render.mjs') };
  const promised = /点开[^。；\n：]{0,20}(可以看到|就能看到|可查看|即可看到)[^。；\n]{0,20}(三步安装说明|安装说明|怎么装)/;
  const promisedDetail = /点开[^。；\n：]{0,20}(可以看到|就能看到|可查看|即可看到)[^。；\n]{0,20}(详细介绍|详细说明)/;

  for (const [name, source] of Object.entries(sources)) {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.ok(!promised.test(code), `${name} 里承诺了点开就能看安装说明`);
    assert.ok(!promisedDetail.test(code), `${name} 里承诺了点开就能看详细介绍`);
  }

  // 由纯函数产出的提示语与卡片文案也一起断言（它们才是用户真正看到的字）。
  const view = buildBoardView({ items: threeItems(), boardId: 'weekly', daily: daily() });
  const hintHtml = view.hints.map((h) => h.html).join('\n');
  assert.ok(!promised.test(hintHtml), '提示语里承诺了点开就能看安装说明');
  assert.ok(!promisedDetail.test(hintHtml), '提示语里承诺了点开就能看详细介绍');
  assert.match(hintHtml, /还在做/, '要如实说清"还在做"');
  assert.match(hintHtml, /prepare\.html/, '新手准备页的入口要在');

  const card = itemCard({ boardId: 'weekly', item: item({}) });
  assert.ok(!promised.test(card), '卡片上仍在承诺点开就能装');
  assert.ok(!promisedDetail.test(card), '卡片上仍在承诺点开就能看详情');

  // 承认现状：点击时给的那句提示才是实话（Task 17 接上抽屉后，这几条断言要一起改）。
  assert.match(read('app.js'), /下一个版本/);
});

// ---------- ⑩ 静态服务器真的把页面送到浏览器 ----------

test('静态服务器提供的首页确实带着三个榜签', async () => {
  const server = createStaticServer({ root: 'public' });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    assert.match(html, /本周飙升/);
    assert.match(html, /经典必玩/);
  } finally {
    await new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    });
  }
});
