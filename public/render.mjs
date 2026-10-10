// GitHub 好玩榜 —— 页面渲染层（纯函数，不碰 DOM、不读时钟、不发请求）。
//
// 为什么单独一层：这些函数决定"用户看到哪几个字"，而"不许说谎"是本项目的产品约束
// （spec §4.3 术语翻译表、§7.3 界面必须诚实），所以它们必须能被 node:test 直接断言，
// 而不是埋在事件回调里只能靠肉眼看。输入是 JSON 里的条目，输出是 HTML 字符串。
//
// 五条硬规矩（每一条都对应一次真实缺陷）：
//   · 行话禁令（spec §4.3）：界面上不出现外文行话原词，也不泄露内部字段名。
//     翻译表：收藏人数 / 收藏速度 → 用"收藏"这类说法；"拿去改造"代替那个以 F 开头的词；
//     "作者管不管事"代替那个以 I 开头的词；"作者已停止维护"代替那个表示停更的英文词；
//     "项目"代替那个表示代码仓库的词。本文件自身也不写这些原词：一旦出现在注释里，
//     下一个人复制粘贴时就可能顺手带进界面文案。行话清单由 test/page-content.test.mjs 钉住。
//   · R25：经典必玩榜按总收藏排序、**不参与三轴评分**，所以那个榜不渲染分数摘要
//     （渲染了就是在暗示"它是按分数排的"）；改说总收藏人数 + 最后更新时间。
//   · R64：徽章「🈶 有中文说明」只认 hasChinese === true。只有非中文本地化文档时如实说
//     「有本地化文档（非中文）」—— 绝不能拿它冒充中文。
//   · 置信度（spec §7.3）：估算值写"约 N（估算）"、转述写"N（GitHub 官方数据）"、
//     实测写"N（实测）"；velocitySource 是 'none' 表示**我们根本没问到**，
//     那时不许渲染成"涨 0"（那是在陈述一件我们并不知道的事实），整行省略。
//   · 取证来源（install.evidence）不许原样出现：那是内部用的英文键名，
//     翻译成一句中文说法，认不出来就不说。

/** 中文徽章：真的查到中文文档才给。 */
export const CHINESE_BADGE = '🈶 有中文说明';
/** 只有非中文本地化文档时的徽章（R64）：照实说，不冒充中文。 */
export const LOCALIZED_ONLY_BADGE = '有本地化文档（非中文）';

/** 难度徽章文案（spec §4.2）。 */
const GRADE_BADGES = new Map([
  ['green', '🟢 一键就能玩'],
  ['yellow', '🟡 要几步'],
  ['red', '🔴 要懂点技术'],
]);

/** 难度徽章后面那句"要准备什么"（spec §4.2 的界面文案）。 */
const GRADE_HINTS = new Map([
  ['green', '下载就能用'],
  ['yellow', '跟着 3 步走就行'],
  ['red', '需要一点技术基础'],
]);

/** 涨星速度的三种置信度 → 前缀与括号说明（与 src/score/reasons.mjs 同一口径，spec §7.3）。 */
const CONFIDENCE_WORDS = new Map([
  ['measured', { lead: '', tail: '（实测）' }],
  ['estimated', { lead: '约', tail: '（估算）' }],
  ['reported', { lead: '', tail: '（GitHub 官方数据）' }],
]);

/**
 * 内部取证字段（install.evidence）的中文说法。
 * 这些值是"我们凭什么敢让你装这个包"的证据来源，不是给用户看的键名：原文是
 * 'repository' / 'bugs.url' / 'homepage' / 'project_urls' / 'home_page' / 'none'，
 * 直接显示等于把内部字段名甩到用户脸上。认不出来时统一说"我们查到了官方出处"，绝不回显原文。
 */
const EVIDENCE_TEXTS = new Map([
  ['repository', '这个包自己在页面上写着它来自这个项目。'],
  ['bugs.url', '这个包把问题反馈地址指向了这个项目。'],
  ['homepage', '这个包的主页地址填的就是这个项目。'],
  ['project_urls', '这个包的官方页面里列着这个项目。'],
  ['home_page', '这个包的官方页面填的就是这个项目。'],
  // 'none' 表示归属不成立：那种情况下根本不该有安装命令，所以这里给的是一句
  // "我们没敢让你照着装"的说明，而不是回显这个内部取值。
  ['none', '我们没能确认这个包属于这个项目，所以没有给你安装命令。'],
]);

/** 三轴的中文名（详情与分数摘要共用，界面上不出现 hot / reputation 这类英文键名）。 */
const AXES = [
  { key: 'hot', label: '热度' },
  { key: 'reputation', label: '口碑' },
  { key: 'runnable', label: '新手友好' },
];

/** 三轴的满分（spec §6.1）；详情页画分数条时用来折算宽度。 */
const FULL_MARKS = { hot: 45, reputation: 30, runnable: 25 };

/** 没问到新增收藏时那句诚实话（**不是**"涨 0"：那是在陈述我们并不知道的事实）。 */
const GROWTH_UNKNOWN_TEXT = '这一周的新增收藏，我们没有查到';

/** 把值转成 HTML 安全文本：所有来自 JSON 的字符串都要过这一道。 */
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 有限数字判定（拿不到就是拿不到，绝不用 0 顶替）。 */
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

/** 千分位；拿不到数字时返回空串。 */
const num = (value) => (isNum(value) ? value.toLocaleString('zh-CN') : '');

/** 项目名：没有 name 时退回 ownerRepo 的后半段；两者都没有就说"这个项目"。 */
function projectName(item) {
  if (typeof item?.name === 'string' && item.name !== '') return item.name;
  const full = typeof item?.ownerRepo === 'string' ? item.ownerRepo : '';
  const tail = full.split('/').pop();
  return tail === undefined || tail === '' ? '这个项目' : tail;
}

/**
 * 本周新增收藏。三态照实标注（spec §7.3），不知道时**整行不显示**（见文件头第四条）。
 * @param {{ gained7d?: number, confidence?: string, source?: string, velocitySource?: string }} [velocity]
 * @returns {{ known: boolean, text: string, tone: 'estimated'|'measured'|'reported'|'unknown' }}
 */
export function growthNotice(velocity) {
  const gained = velocity?.gained7d;
  const source = velocity?.velocitySource ?? velocity?.source ?? null;
  // 'none' = 五级阶梯一级都没命中：不是"涨了 0"，是我们没问到。数值缺失同理。
  if (source === 'none' || !isNum(gained)) {
    return { known: false, text: '', tone: 'unknown' };
  }
  const words = CONFIDENCE_WORDS.get(velocity?.confidence);
  // 置信度认不出来时不带括号：宁可少说一句，也不假装它是实测（与 reasons.mjs 同一口径）。
  if (!words) {
    return { known: true, text: `本周新增收藏 ${num(gained)}`, tone: 'unknown' };
  }
  // 前缀与数字之间固定留一个空格：界面上读起来是"约 900（估算）"，而不是挤在一起的"约900"。
  const lead = typeof words.lead === 'string' && words.lead !== '' ? `${words.lead} ` : '';
  return { known: true, text: `本周新增收藏 ${lead}${num(gained)}${words.tail}`, tone: velocity.confidence };
}

/**
 * 近 3 日新增：只有真有 3 日数据（gained3d 是数字）时才出现，同时带上置信度标注。
 * @param {{ gained3d?: number, confidence?: string, source?: string, velocitySource?: string }} [velocity]
 * @returns {string} 一句话；没有数据时返回空串
 */
export function confidenceNotice(velocity) {
  const source = velocity?.velocitySource ?? velocity?.source ?? null;
  if (source === 'none' || !isNum(velocity?.gained3d)) return '';
  const words = CONFIDENCE_WORDS.get(velocity?.confidence);
  const tail = words ? words.tail : '';
  return `近 3 日新增 ${num(velocity.gained3d)}${tail}`;
}

/**
 * 取证来源的中文说法（**绝不回显英文原始值**）。
 * @param {string} [evidence] install.evidence 的原始值
 * @returns {string} 一句中文；没有证据时返回空串
 */
export function evidenceNotice(evidence) {
  if (typeof evidence !== 'string' || evidence === '') return '';
  const known = EVIDENCE_TEXTS.get(evidence);
  if (known) return known;
  // 'none' 表示归属不成立，那时根本不该有安装命令，所以这里不替它编话。
  if (evidence === 'none') return '';
  return '我们查到了官方出处，确认这个包属于这个项目。';
}

/**
 * 难度徽章（spec §4.2）。等级认不出来时不显示徽章——猜一个难度比不显示更糟。
 * @param {string} [grade] 'green' | 'yellow' | 'red'
 * @returns {string} 徽章 HTML；认不出来时空串
 */
export function difficultyBadge(grade) {
  const text = GRADE_BADGES.get(grade);
  return text === undefined ? '' : `<span class="badge badge-${esc(grade)}">${text}</span>`;
}

/**
 * 中文徽章。R64 的三分支，一条都不能合并：
 *   · hasChinese === true      → 「🈶 有中文说明」
 *   · 否则有本地化文件          → 「有本地化文档（非中文）」（有本地化文档 ≠ 有中文）
 *   · 都没有                    → 不给徽章（我们没查到，就不说）
 * @param {{ hasChinese?: boolean, localizedFiles?: string[] }} [item]
 * @returns {string} 徽章 HTML；不该给时是空串
 */
export function chineseBadge(item) {
  if (item?.hasChinese === true) return `<span class="badge badge-cn">${CHINESE_BADGE}</span>`;
  const files = Array.isArray(item?.localizedFiles) ? item.localizedFiles.filter((f) => typeof f === 'string' && f !== '') : [];
  if (files.length === 0) return '';
  return `<span class="badge badge-cn-alt" title="${esc(files.join('、'))}">${LOCALIZED_ONLY_BADGE}</span>`;
}

/**
 * 三轴分数摘要（周榜与新手榜用）。
 * R25：经典榜**不参与三轴评分**，所以传进来的 boardId 是 classic 时直接返回空串——
 * 那个榜按总收藏排序，给它画分数条等于告诉用户"它是按分数排上来的"。
 * @param {string} boardId 榜单 id
 * @param {{ scores?: object }} item 条目
 * @returns {string} 一行分数摘要；经典榜或没有分数时是空串
 */
export function boardScore(boardId, item) {
  if (boardId === 'classic') return '';
  const scores = item?.scores;
  if (!scores || !isNum(scores.total)) return '';
  const axes = AXES
    .filter((axis) => isNum(scores[axis.key]))
    .map((axis) => `<span class="axis"><span class="axis-name">${axis.label}</span>${num(scores[axis.key])}</span>`)
    .join('');
  return `<div class="score-summary"><span class="score-total">综合 ${num(scores.total)} 分</span>${axes}</div>`;
}

/**
 * 三轴分数条（详情里"为什么上榜"摊开公式时用，spec §4.4）。
 * 经典榜同样不渲染（R25）。
 * @param {string} boardId 榜单 id
 * @param {{ scores?: object }} item 条目
 * @returns {string} 分数条 HTML；经典榜或没有分数时是空串
 */
export function scoreBars(boardId, item) {
  if (boardId === 'classic') return '';
  const scores = item?.scores;
  if (!scores) return '';
  const rows = AXES.filter((axis) => isNum(scores[axis.key])).map((axis) => {
    const value = scores[axis.key];
    // 轴满分写在权重表里（热度 45 / 口碑 30 / 新手友好 25）：宽度按满分折算，
    // 满分读不出来时退回按 100 折算，绝不编一个"满格"的进度条。
    const full = FULL_MARKS[axis.key] ?? 100;
    const width = Math.max(0, Math.min(100, Math.round((value / full) * 100)));
    return `<div class="bar-row"><span class="bar-label">${axis.label}</span>`
      + `<span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>`
      + `<span class="bar-value">${num(value)}</span></div>`;
  });
  if (rows.length === 0) return '';
  return `<div class="score-bars">${rows.join('')}</div>`;
}


/**
 * 项目基本事实（详情与经典榜卡片共用）。拿不到的事实整条不列，绝不用一个占位符假装成"没有"。
 * @param {object} item 条目
 * @returns {{ label: string, value: string }[]}
 */
export function factList(item) {
  const facts = [];
  if (typeof item?.language === 'string' && item.language !== '') facts.push({ label: '写它的语言', value: item.language });
  if (isNum(item?.stars)) facts.push({ label: '有多少人收藏', value: num(item.stars) });
  if (isNum(item?.forks)) facts.push({ label: '有多少人拿去改造', value: num(item.forks) });
  const pushed = formatTime(item?.pushedAt);
  if (pushed !== '') facts.push({ label: '最后更新时间', value: pushed });
  if (typeof item?.license === 'string' && item.license !== '') facts.push({ label: '许可证', value: item.license });
  // 数据里那个表示"作者主动停更"的布尔字段（上游契约用的英文键名）在这里翻译成一句诚实的中文。
  // 字段名本身绝不渲染出去：界面上只说结论。
  if (item?.archived === true) facts.push({ label: '维护状态', value: '作者已停止维护' });
  return facts;
}

/**
 * 按榜单给"这张卡片该说的话"（R25 的分支点）。
 * 经典必玩榜是"补课"用的：给总收藏人数与最后更新时间，**不给三轴分数**；
 * 另外两个榜按三轴评分排，就给分数摘要。
 * @param {string} boardId 榜单 id
 * @param {object} item 条目
 * @returns {{ label: string, value: string }[]}
 */
export function factsForBoard(boardId, item) {
  if (boardId === 'classic') {
    const facts = [];
    if (isNum(item?.stars)) facts.push({ label: '总收藏人数', value: num(item.stars) });
    const pushed = formatTime(item?.pushedAt);
    if (pushed !== '') facts.push({ label: '最后更新时间', value: pushed });
    return facts;
  }
  const facts = [];
  if (isNum(item?.scores?.total)) facts.push({ label: '综合得分', value: `${num(item.scores.total)} 分` });
  if (isNum(item?.stars)) facts.push({ label: '总收藏人数', value: num(item.stars) });
  return facts;
}

/**
 * ISO 时间 → 中文日期（只到天）。读不出来返回空串：不猜、不显示"Invalid Date"。
 * @param {string} [iso]
 * @returns {string}
 */
export function formatTime(iso) {
  if (typeof iso !== 'string' || iso === '') return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()} 年 ${pad(date.getUTCMonth() + 1)} 月 ${pad(date.getUTCDate())} 日`;
}

/**
 * 卡片上的元信息：难度徽章 + 中文徽章 + 新增收藏（含近 3 日，有数据才显示）+ 事实。
 * 卡片上**不放三轴明细**（那是点开详情才看的东西），所以这里不调 boardScore。
 * @param {{ boardId: string, item: object }} input
 * @returns {string} HTML
 */
export function itemMeta({ boardId, item }) {
  const badges = [difficultyBadge(item?.grade), chineseBadge(item)].filter((html) => html !== '').join('');
  // 数据文件里的速度字段有两套写法：collector 既写扁平的顶层字段（starsGained7d / confidence /
  // velocitySource），也把原始 velocity 对象整个带下来。这里先把两套合成一份再判定 ——
  // 只看 item.velocity 会漏掉扁平字段，而漏掉的后果是把"我们没问到"渲染成"新增 0"（正是要防的谎话）。
  const velocity = {
    gained7d: item?.velocity?.gained7d ?? item?.starsGained7d,
    gained3d: item?.velocity?.gained3d ?? item?.starsGained3d,
    confidence: item?.velocity?.confidence ?? item?.confidence,
    // 源头优先信扁平字段：collector 用的是它，raw 对象里可能根本没有这个键。
    source: item?.velocitySource ?? item?.velocity?.source,
  };
  const growth = growthNotice(velocity);
  const growthHtml = growth.known
    ? `<span class="growth growth-${esc(growth.tone)}">${esc(growth.text)}</span>`
    : `<span class="growth growth-unknown">${GROWTH_UNKNOWN_TEXT}</span>`;
  // 近 3 日新增：日线数据确实覆盖了 3 天时才有这个值，没有就整条不显示（绝不当成"3 天涨 0"）。
  const threeDay = confidenceNotice(velocity);
  const threeDayHtml = threeDay === '' ? '' : `<span class="growth growth-3d">${esc(threeDay)}</span>`;
  const facts = factsForBoard(boardId, item)
    .map((fact) => `<span class="fact"><span class="fact-label">${esc(fact.label)}</span>${esc(fact.value)}</span>`)
    .join('');
  return `<div class="badges">${badges}</div><div class="meta-line">${growthHtml}${threeDayHtml}${facts}</div>`;
}

/**
 * 榜单为空 / 这一期没有数据时的提示（第一等状态，spec §8）。
 * 说法必须区分"这一期确实没有条目"与"这一期数据不完整"——原因不同，不能混成一句。
 * @param {{ boardTitle?: string, itemCount?: number }} [input]
 * @returns {string} HTML；有条目时是空串
 */
export function boardNotice(input = {}) {
  const count = input.itemCount;
  if (isNum(count) && count > 0) return '';
  const title = typeof input.boardTitle === 'string' && input.boardTitle !== '' ? input.boardTitle : '这个榜';
  return `<p class="empty">「${esc(title)}」暂时没有可以展示的项目。可能是这一期还没采集到合适的项目，`
    + '也可能是筛选条件把条目都过滤掉了，换一个筛选条件或者换一天再看看。</p>';
}

/**
 * 这一期数据不完整时的提示（degraded，spec §8）。notes 缺失或为空都要能正常工作。
 * @param {boolean} degraded 本轮是否有东西没拿到
 * @param {string[]} [notes] 降级原因（给维护者看的），有就一起显示
 * @returns {string} HTML；没有问题就是空串
 */
export function degradedNotice(degraded, notes) {
  if (degraded !== true) return '';
  const lines = (Array.isArray(notes) ? notes : [])
    .filter((note) => typeof note === 'string' && note !== '')
    .map((note) => `<li>${esc(note)}</li>`)
    .join('');
  return '<div class="notice notice-degraded"><strong>本期数据不完整。</strong>'
    + '有些项目的信息这一期没采集到（通常是网络或额度问题），所以下面的内容可能不全，'
    + '看到空缺不代表这个项目不好。'
    + (lines === '' ? '' : `<ul class="notice-notes">${lines}</ul>`)
    + '</div>';
}

/**
 * 数据完全读不到时的提示（例如 index.json 还是空的：还没跑过采集）。
 * @returns {string} HTML
 */
export function noDataNotice() {
  return '<div class="notice notice-empty"><strong>还没有任何榜单数据。</strong>'
    + '这个网站读的是数据文件，需要先运行一次采集（或者用演示数据启动）才会出现内容。'
    + '如果你是在本地预览，可以在项目目录里运行 <code>npm run collect</code> 或 <code>npm run demo</code>。</div>';
}

/**
 * 某一天的数据文件没读到时的提示（文件缺了、或者地址写错了）。
 * @param {string} [date] 想看的那一天
 * @param {number} [dateCount] 一共有几天可看（>0 时提示"换一天"是条能走的路）
 * @returns {string} HTML
 */
export function missingDateNotice(date, dateCount) {
  const day = typeof date === 'string' && date !== '' ? date : '这一天';
  const more = isNum(dateCount) && dateCount > 0
    ? '你可以在页面底部换一天再看，或者稍后刷新重试。'
    : '这个网站读的是数据文件，需要先运行一次采集才会有内容。';
  return `<div class="notice notice-empty"><strong>没有读到 ${esc(day)} 的榜单数据。</strong>${more}</div>`;
}

/**
 * 一条项目卡片的内部内容（外层的 <article> 由 app.js 包上，Task 17 的详情抽屉挂在它上面）。
 * @param {{ boardId: string, item: object }} input
 * @returns {string} HTML
 */
export function itemCard({ boardId, item }) {
  const rank = isNum(item?.rank) ? `<span class="rank">${item.rank}</span>` : '';
  const description = typeof item?.description === 'string' && item.description !== ''
    ? esc(item.description)
    : '这个项目没有写一句话介绍。';
  const reasons = Array.isArray(item?.reasons) ? item.reasons.filter((r) => typeof r === 'string' && r !== '') : [];
  const reasonHtml = reasons.length === 0
    ? ''
    : `<ul class="reasons">${reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>`;
  const full = typeof item?.ownerRepo === 'string' ? item.ownerRepo : '';
  const link = full === '' ? '' : `<a class="project-link" href="https://github.com/${esc(full)}" target="_blank" rel="noreferrer noopener">打开项目主页</a>`;

  return `${rank}<div class="card-body">`
    + `<h3 class="card-title">${esc(projectName(item))}</h3>`
    + `<p class="card-desc">${description}</p>`
    + itemMeta({ boardId, item })
    + boardScore(boardId, item)
    + reasonHtml
    + `<div class="card-actions">${link}<span class="hint">想看怎么装？点开这张卡片。</span></div>`
    + '</div>';
}
