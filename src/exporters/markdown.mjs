// GitHub 好玩榜 —— 日报 Markdown 导出（spec §5.3 第 ⑦ 步：daily/YYYY-MM-DD.md）。
//
// 日报是给人看的，不是给程序解析的：所以这里只做确定性拼装，不读文件、不发请求、不调大模型，
// 并且**复用 score/reasons.mjs 的同一套文案**（formatVelocityText / buildReasons），
// 让日报与网站说的是同一句话——两处各写一份文案早晚会说岔。
//
// R85（控制者裁定）：渲染的输入就是**网站读的那份 JSON payload**（`buildDailyPayload` 的产物）。
// 为什么原先的写法是错的：调用方交进来的是 buildBoard 的 RankedItem，而这里读的是 JSON 条目上的
// `install` 与 `scores` —— 两者形状不同，于是"装法/下载链接"分支与 installSummary **永远执行不到**，
// 日报里从来没有出现过安装方式（也没有总分）。现在先构造 payload，再用同一份 payload 渲染
// Markdown 与 JSON，两者不可能不一致。
//
// 诚实口径（spec §7.3，本项目被同一类缺陷咬过多次）：
//   · 估算值一律写成"约 1,234（估算）"，这是 formatVelocityText 的职责，日报不再自己拼一遍；
//   · "没问到"的状态（R41 的 hasRelease90d=null / growing=null）在文末如实列出，
//     绝不静默——日报最容易变成"看起来齐全"的地方。
//
// 术语一律走 spec §4.3 的翻译表：不出现 star / fork / issue 这类行话。

import { formatVelocityText, buildReasons } from '../score/reasons.mjs';

const BOARD_ICONS = { weekly: '🔥', newbie: '🌟', classic: '🏆' };

/** 榜单标题前的图标；认不出的榜单 id 给中性图标，不抛错。 */
const iconOf = (boardId) => BOARD_ICONS[boardId] ?? '📋';

/** 三位一组的千分位。刻意不用 toLocaleString：它依赖运行时语言环境，换机器可能换个写法。 */
const thousands = (value) => (Number.isFinite(value) ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—');

/** Markdown 表格单元里的竖线与换行必须转义/压平，否则会把表格撑烂。 */
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/**
 * 一条上榜理由：直接用 JSON 里那一条已经算好的 `reasons`（榜单组装时由 buildReasons 产出）。
 * R85：日报与 JSON 同源，这里不再自己重算——重算就会有两个口径，而且重算时手上的
 * `scores` 与 `score.parts` 形状不同，会静默少掉几条理由。
 * 万一某个调用方给的条目没有 reasons（例如手写的测试数据），才回退到现算一份。
 * @param {object} item JSON payload 里的条目
 * @returns {string[]}
 */
const reasonsOf = (item) => {
  if (Array.isArray(item.reasons) && item.reasons.length > 0) return item.reasons;
  return buildReasons({
    score: item.score ?? { parts: item.scores },
    repo: item.repo,
    velocity: item.velocity,
    runnability: item.runnability,
  });
};

/**
 * 渲染一份榜单的详情段落。
 * 输入是 **JSON payload 里的那份榜单**（不是 buildBoard 的 RankedItem）：
 * R85 要求两者同源，所以这里读的就是网站会读到的那些字段（`scores` / `install` / `ownerRepo`）。
 * @param {object} board payload 里的一条榜单 { id, title, items }
 * @returns {string[]} 行数组
 */
function boardSection(board) {
  const lines = [`## ${iconOf(board.id)} ${board.title}`, ''];
  const items = Array.isArray(board.items) ? board.items : [];
  if (items.length === 0) {
    lines.push('_本期没有项目满足条件。_', '');
    return lines;
  }

  for (const item of items) {
    const repo = item.repo ?? {};
    const scores = item.scores ?? {};
    const gained = formatVelocityText(item.velocity);
    lines.push(`### ${item.rank}. ${item.ownerRepo}`);
    if (repo.description) lines.push(`> ${cell(repo.description)}`);
    lines.push('');

    const facts = [];
    if (Number.isFinite(scores.total)) facts.push(`总分 **${scores.total.toFixed(1)}**（热度 ${num1(scores.hot)} · 口碑 ${num1(scores.reputation)} · 新手友好 ${num1(scores.runnable)}）`);
    if (Number.isFinite(repo.stars)) facts.push(`共 ${thousands(repo.stars)} 人收藏`);
    if (gained) facts.push(gained);
    if (typeof item.install?.kind === 'string') facts.push(installSummary(item));
    // R143 + R153：只有 `hasChinese`（真有中文）才算"有中文说明"；
    // 有非中文本地化文件时如实说清楚；两样都没有就只说我们自己的查找动作（R71）。
    if (item.hasChinese === true) {
      facts.push('有中文说明');
    } else if (Array.isArray(item.localizedFiles) && item.localizedFiles.length > 0) {
      facts.push('有本地化文档（非中文）');
    } else {
      // R71：上游分不清"读过且只有英文"与"README 没拿到"，所以只能说我们自己的查找动作。
      facts.push('我们没有查到中文说明');
    }
    lines.push(facts.map((f) => `- ${f}`).join('\n'));
    lines.push('');

    const reasons = reasonsOf(item);
    if (reasons.length > 0) lines.push(`为什么上榜：${reasons.join(' · ')}`, '');

    // 第 2 步就是要用户动手的那一步：有命令给命令，有链接给链接，都没有就说清去哪儿找。
    // R85：这里读的 `install` 就是 JSON 里嵌好的向导，日报与网站必然给同一件事。
    const step2 = item.install?.steps?.[1];
    if (step2?.command) lines.push('装法：`' + step2.command + '`', '');
    else if (step2?.downloadUrl) lines.push(`下载：${step2.downloadUrl}`, '');
  }
  return lines;
}

/** 一位小数的字符串（拿不到分数时给 '—'，绝不打印 NaN）。 */
const num1 = (value) => (Number.isFinite(value) ? value.toFixed(1) : '—');

/** 安装方式的一句话（与 JSON 的 install.kind 对应），kind 认不出来时给中性描述。 */
function installSummary(item) {
  const { kind, command, downloadUrl, verified } = item.install ?? {};
  if (verified !== true) return '我们还没有核实出一条可用的安装方式';
  switch (kind) {
    case 'releaseWindows': return `有现成的 Windows 安装包（${downloadUrl ?? '下载链接见 JSON'}）`;
    case 'npmBinWin': return `在 Windows 上敲一行命令就能装：${command ?? 'npx …'}`;
    case 'pypiCompatible': return `有现成的安装包：${command ?? 'pip install …'}`;
    case 'npmNoBin': return `要先装好 Node：${command ?? 'npm install …'}`;
    case 'buildFromSource': return '要自己动手编译';
    case 'dockerOnly': return '要先用 Docker';
    default: return '没有已核实的安装方式';
  }
}

/**
 * 渲染整份日报 Markdown。
 * R85（控制者裁定）：入参是 **JSON payload**（`buildDailyPayload` 的产物），不是 buildBoard 的
 * RankedItem。这样日报与网站读的是同一份数据，"装法/下载链接""总分条"这些只有在 payload 里
 * 才存在的字段才真的可用——旧实现把 RankedItem 传进来，那几个分支永远执行不到，
 * 于是日报里从来没有出现过安装方式（也没有总分）。
 * @param {{ date: string, degraded: boolean, notes: string[], boards: object[], demo?: boolean }} payload 日报对象
 *   demo（R146）：payload 自己声明"这是内置样本"时，日报顶部要标注、文末也不许声称数据来自 GitHub；
 * @param {{ degraded?: boolean, notes?: string[], demo?: boolean }} [options] 缺省时用 payload 自带的 degraded/notes/demo
 * @returns {string} 以换行结尾的 Markdown 文本
 */
export function renderDailyMarkdown(payload, options = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const date = typeof source.date === 'string' ? source.date : '';
  const list = Array.isArray(source.boards) ? source.boards : [];
  const degraded = options.degraded ?? source.degraded === true;
  // R146：演示标注必须与 JSON 同源（同一个 payload 的这一位），不能只在网页上标。
  // 日报是会被提交进仓库、被转发给别人看的文件（daily/ 不在 .gitignore 里），
  // 不标就等于把内置样本当成"今天的热门项目"发出去。
  const demo = options.demo ?? source.demo === true;
  const lines = [`# GitHub 好玩榜 · ${date}`, ''];

  if (demo === true) {
    lines.push(
      `> ⚠️ **这是演示数据（内置样本），不是从网上采集来的真实数据。** 它代表 ${date || '某一天'} 这一天的榜单，`
      + '内容来自项目自带的样本，只用来展示这份日报长什么样；**它不代表最近真的在流行什么**。',
      '',
    );
  }

  if (degraded === true) {
    lines.push('> ⚠️ **本期数据不完整**：这一轮有东西没拿到（网络、额度或改版），下面标出的项目可能少了若干条信息。', '');
  }

  // 总览表：先让人一眼看到三个榜的前几名，再往下读详情。
  lines.push('## 今天的三个榜', '');
  lines.push('| 榜单 | 条数 | 前三名 |', '| --- | --- | --- |');
  for (const board of list) {
    const items = Array.isArray(board.items) ? board.items : [];
    const top = items.slice(0, 3).map((x) => x.ownerRepo).join('、') || '—';
    lines.push(`| ${iconOf(board.id)} ${cell(board.title)} | ${items.length} | ${cell(top)} |`);
  }
  lines.push('');

  for (const board of list) lines.push(...boardSection(board));

  const rawNotes = options.notes ?? source.notes;
  const notes = Array.isArray(rawNotes) ? rawNotes.filter((n) => typeof n === 'string' && n !== '') : [];
  if (notes.length > 0) {
    lines.push('## 这一轮我们没拿到什么', '');
    for (const note of notes) lines.push(`- ${cell(note)}`);
    lines.push('');
  }

  lines.push(
    '---',
    '',
    // R146：数据来源那一句必须与"这份数据是从哪来的"一致。演示数据时**绝不能说**
    // "来自 GitHub 公开 API"——那是日报最容易撒的一个谎（文件会被提交、会被转发）。
    ...(demo === true
      ? [
        '数据来源：**项目自带的演示样本**（用内置候选跑出来的），不是从 GitHub 采集的真实数据。',
        '涨星速度、榜单排序、安装向导都由正式代码算出，但输入是样本，所以数字没有现实意义。',
      ]
      : [
        '数据来源：GitHub 公开 API 与 github.com/trending 页面。涨星速度按五级降级阶梯取，',
        '标着"（估算）"的数字是外推得到的，不是实测值；看不出来源时我们会说"没查到"，不会编一个数。',
      ]),
    '',
  );
  return lines.join('\n');
}
